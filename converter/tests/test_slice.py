"""Slice-extraction tests (docs/plan.md Phase 11).

Covers the parser label events plus the CLI slice options: --label starts
the walk at a label, --max-items caps the item count, --files restricts
which .rpy files feed the walk. Default behavior (no options) is asserted
unchanged via comparison with the full fixture extraction.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"


def extract(out: Path, *opts: str) -> dict:
    rc = cli_main([str(FIXTURE), str(out), *opts])
    assert rc == 0
    return json.loads((out / "manifest.json").read_text("utf-8"))


def content(item: dict) -> dict:
    """Item identity without numbering: id/file/poster embed item ids."""
    return {k: v for k, v in item.items()
            if k not in ("id", "file", "poster")}


# --- parser: labels are positioned in the event stream --------------------

def test_parse_file_emits_label_events() -> None:
    parsed = parse_file("label start:\n    \"a\"\nlabel inside(x):\n",
                        "game/script.rpy")
    labels = [(e.kind, e.name) for e in parsed.events if e.kind == "label"]
    assert labels == [("label", "start"), ("label", "inside")]


# --- --max-items -----------------------------------------------------------

def test_max_items_caps_walk_at_n_items(tmp_path: Path) -> None:
    full = extract(tmp_path / "full")
    sliced = extract(tmp_path / "cap", "--max-items", "3")
    assert len(sliced["items"]) == 3
    # A slice from the top is the same first items, same numbering.
    assert sliced["items"] == full["items"][:3]


def test_max_items_zero_yields_empty_manifest(tmp_path: Path) -> None:
    sliced = extract(tmp_path / "zero", "--max-items", "0")
    assert sliced["items"] == []


# --- --label ---------------------------------------------------------------

def test_label_slice_is_a_suffix_of_the_full_run(tmp_path: Path) -> None:
    full = extract(tmp_path / "full")
    sliced = extract(tmp_path / "label", "--label", "inside")
    assert 0 < len(sliced["items"]) < len(full["items"])
    # `label inside:` runs to end of script, so the slice is the full
    # flow's tail (compared without id-derived fields).
    tail = [content(i) for i in full["items"]][-len(sliced["items"]):]
    assert [content(i) for i in sliced["items"]] == tail


def test_label_with_max_items_combines(tmp_path: Path) -> None:
    from_label = extract(tmp_path / "label", "--label", "inside")
    both = extract(tmp_path / "both", "--label", "inside",
                   "--max-items", "2")
    assert [content(i) for i in both["items"]] == \
        [content(i) for i in from_label["items"][:2]]


def test_unknown_label_is_fatal(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as excinfo:
        cli_main([str(FIXTURE), str(tmp_path / "out"),
                  "--label", "no_such_label"])
    assert excinfo.value.code != 0 or isinstance(excinfo.value.code, str)


# --- --files ---------------------------------------------------------------

def test_files_glob_matching_all_is_the_default(tmp_path: Path) -> None:
    full = extract(tmp_path / "full")
    globbed = extract(tmp_path / "glob", "--files", "script.rpy")
    assert globbed["items"] == full["items"]


def test_files_glob_matching_nothing_exits_1(tmp_path: Path,
                                             capsys: pytest.CaptureFixture,
                                             ) -> None:
    rc = cli_main([str(FIXTURE), str(tmp_path / "out"),
                   "--files", "no_such_*.rpy"])
    assert rc == 1
    assert "no_such_" in capsys.readouterr().err


# --- ledger ----------------------------------------------------------------

def test_ledger_records_slice_options(tmp_path: Path) -> None:
    rc = cli_main([str(FIXTURE), str(tmp_path / "out"),
                   "--label", "inside", "--max-items", "2"])
    assert rc == 0
    ledger = json.loads((tmp_path / "out" / "build-ledger.json")
                        .read_text("utf-8"))
    assert ledger["slice"] == {"label": "inside", "maxItems": 2,
                               "files": None}
    assert ledger["inputs"] == ["game/script.rpy"]


def test_full_run_ledger_has_no_slice_key(tmp_path: Path) -> None:
    rc = cli_main([str(FIXTURE), str(tmp_path / "out")])
    assert rc == 0
    ledger = json.loads((tmp_path / "out" / "build-ledger.json")
                        .read_text("utf-8"))
    assert "slice" not in ledger
