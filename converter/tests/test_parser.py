"""Tests for the kinetic-extract parser and CLI over fixtures/renpy_demo."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from helpers import is_content_addressed
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
GOLDEN = Path(__file__).parent / "data" / "renpy_demo.manifest.json"


def extract(tmp_path: Path) -> dict:
    rc = cli_main([str(FIXTURE), str(tmp_path)])
    assert rc == 0
    return json.loads((tmp_path / "manifest.json").read_text("utf-8"))


def load_ledger(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "build-ledger.json").read_text("utf-8"))


def test_golden_manifest(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    assert manifest == json.loads(GOLDEN.read_text("utf-8"))


def test_movie_item_gets_duration_via_ffprobe(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    videos = [i for i in manifest["items"] if i["type"] == "video"]
    assert len(videos) == 1
    video = videos[0]
    # The fixture clip is 1 s; allow a little slack for ffprobe rounding.
    assert 0.9 < video["durationSeconds"] <= 1.1
    assert video["file"].endswith(".mp4")
    assert video["poster"].endswith(".jpg")
    assert is_content_addressed(tmp_path, video["file"])
    assert is_content_addressed(tmp_path, video["poster"])


def test_skipped_report_contents(tmp_path: Path) -> None:
    extract(tmp_path)
    ledger = load_ledger(tmp_path)
    reasons = [r["reason"] for r in ledger["report"]]
    statements = [r["statement"] for r in ledger["report"]]
    assert "unrecognized statement: imgfl 12345" in reasons
    assert "imgfl 12345" in statements
    assert any("menu unsupported" in r for r in reasons)
    assert any("cross-file call" in r for r in reasons)
    assert any("transform statement" in r for r in reasons)
    assert any("hide skipped" in r for r in reasons)
    # Every item carries its source location and (where known) asset.
    for entry in ledger["items"].values():
        assert entry["source"].startswith("game/script.rpy:")
    assert ledger["items"]["bg-room-001"]["asset"] == "game/data/bg-room.png"
    assert ledger["items"]["clip-004"]["asset"] == "game/data/clip.mp4"
    assert ledger["inputs"] == ["game/script.rpy"]
    assert ledger["simplifications"]


def test_character_display_name_mapping(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    speakers = {i["id"]: i.get("speaker") for i in manifest["items"]}
    assert speakers["bg-room-001"] == "Ana"          # define a = Character
    assert speakers["line-007"] == "Гостья"          # Cyrillic display name
    assert speakers["line-002"] == "Viktor"          # raw name passes through
    assert speakers["bg-yard-006"] is None           # narration: no speaker
    entry = load_ledger(tmp_path)["items"]["bg-room-001"]
    assert any("display name" in n for n in entry["notes"])


def test_cyrillic_round_trip(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    texts = [i.get("text") for i in manifest["items"]]
    assert "Тени танцуют на стене." in texts
    assert "Тишина в саду. [wind]" in texts
    raw = (tmp_path / "manifest.json").read_bytes()
    assert "Тени".encode("utf-8") in raw  # stored as real UTF-8, not escaped


def test_interpolation_kept_literal(tmp_path: Path) -> None:
    manifest = extract(tmp_path)
    by_id = {i["id"]: i for i in manifest["items"]}
    assert by_id["line-002"]["text"] == "The lights are dim. [greeting]?"
    ledger = load_ledger(tmp_path)
    assert any("interpolation" in n
               for n in ledger["items"]["line-002"]["notes"])
    assert not any("interpolation" in n
                   for n in ledger["items"]["bg-room-001"]["notes"])


def test_bom_and_cyrillic_parse_direct() -> None:
    text = ("\ufefflabel start:\n"
            "    scene bg\n"
            "    a \"Привет, мир.\"\n")
    parsed = parse_file(text, "game/x.rpy")
    dialogue = [e for e in parsed.events if e.kind == "dialogue"]
    assert [e.text for e in dialogue] == ["Привет, мир."]
    assert [e.speaker for e in dialogue] == ["a"]
    assert parsed.reports == []


def test_unknown_statement_reported_not_fatal() -> None:
    parsed = parse_file("imgfl 12345\nfoo bar \"baz\" qux\n", "game/x.rpy")
    reasons = [r.reason for r in parsed.reports]
    assert any(reason.startswith("unrecognized statement") for reason in reasons)
    assert len(parsed.reports) == 2  # both unknown lines reported


def test_cli_end_to_end(tmp_path: Path) -> None:
    out = tmp_path / "out"
    proc = subprocess.run(
        [sys.executable, "-m", "kinetic_extract", str(FIXTURE), str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    assert "reported statements:" in proc.stdout  # skipped/notes summary
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert manifest == json.loads(GOLDEN.read_text("utf-8"))
    shim = (out / "manifest.js").read_text("utf-8")
    assert shim.startswith("window.KINETIC_MANIFEST = ")
    assert json.loads(shim[len("window.KINETIC_MANIFEST = "):-2]) == manifest


def test_validator_passes_with_ledger(tmp_path: Path) -> None:
    """The asset pass shipped every file; the ledger is a tolerated extra."""
    out = tmp_path / "out"
    assert cli_main([str(FIXTURE), str(out)]) == 0
    assert (out / "build-ledger.json").exists()
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == ""


def test_fixture_size_budget() -> None:
    total = sum(f.stat().st_size for f in FIXTURE.rglob("*") if f.is_file())
    assert total < 200 * 1024, f"fixture is {total} bytes"
