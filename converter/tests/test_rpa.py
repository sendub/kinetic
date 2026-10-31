"""`.rpa` archive reader tests (docs/plan.md Phase 11, item 3).

The archives are BUILT IN-TEST by a writer helper matching the format
verified against the corpus: `RPA-3.0 <index_offset:16hex> <xor_key:8hex>\\n`
with a zlib+pickle index at the tail whose (offset, length) pairs are
XOR-obfuscated with the header key, and `RPA-2.0 <index_offset:16hex>\\n`
with plain offsets; member bytes are stored uncompressed. No test touches
the Ren'Py corpus.

Covered: round-trip read of a tiny archive, corrupt-index error,
archive `.rpy`/`.rpyc` members feeding the parser (with the real
`data/credits.rpyc` fixture bytes stored as an archive member), the asset
fallback extracting a member and shipping it through the existing asset
pipeline, and the ledger provenance both for scripts and for assets.
"""

from __future__ import annotations

import json
import pickle
import zlib
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_project

FIXTURE_RPYC = Path(__file__).parent / "data" / "credits.rpyc"
_MARKER = b"Made with Ren'Py."


def write_rpa(path: Path, files: dict[str, bytes], version: int = 3,
              key: int = 0x42424242) -> Path:
    """Write a minimal, spec-shaped .rpa holding `files` (name -> bytes)."""
    payload = bytearray()
    index: dict[str, list] = {}
    # Fixed-size header lines, formatted with the real values when written.
    head_tmpl = (b"RPA-3.0 0000000000000000 00000000\n" if version == 3
                 else b"RPA-2.0 0000000000000000\n")
    marker = _MARKER if version == 3 else b""
    offset = len(head_tmpl) + len(marker)
    for name, blob in files.items():
        obf = (lambda v: v ^ key) if version == 3 else (lambda v: v)
        index[name] = [(obf(offset), obf(len(blob)), b"")]
        payload += blob
        offset += len(blob)
    index_blob = zlib.compress(pickle.dumps(index, 2))
    index_offset = len(head_tmpl) + len(marker) + len(payload)
    head = ((b"RPA-3.0 %016x %08x\n" % (index_offset, key)) if version == 3
            else (b"RPA-2.0 %016x\n" % index_offset))
    assert len(head) == len(head_tmpl)
    with open(path, "wb") as f:
        f.write(head)
        f.write(marker)
        f.write(bytes(payload))
        f.write(index_blob)
    return path


def tiny_png_bytes(color=(200, 30, 30)) -> bytes:
    from io import BytesIO
    img = Image.new("RGB", (24, 16), color)
    buf = BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(autouse=True)
def _isolated_caches(tmp_path, monkeypatch):
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "extract-cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))
    yield
    rpa_mod.reset_cache()


# --- reader -----------------------------------------------------------------

def test_round_trip_read_members(tmp_path: Path) -> None:
    rpy = b'label start\n    "hello"\n'
    png = tiny_png_bytes()
    arc = rpa_mod.open_archive(
        write_rpa(tmp_path / "a.rpa", {"game/s.rpy": rpy,
                                       "bg/room.png": png}))
    assert arc.names() == ["bg/room.png", "game/s.rpy"]
    assert arc.version == 3
    assert arc.open("game/s.rpy") == rpy
    assert arc.open("bg/room.png") == png
    assert arc.size("bg/room.png") == len(png)
    dest = tmp_path / "out" / "room.png"
    assert arc.extract_to("bg/room.png", dest) == len(png)
    assert dest.read_bytes() == png
    with pytest.raises(rpa_mod.RpaError, match="no member"):
        arc.open("missing.png")


def test_rpa_v2_round_trip(tmp_path: Path) -> None:
    # Plain (unobfuscated) offsets; a >0xFF size guards the hex parsing.
    blob = bytes(range(256)) * 7
    arc = rpa_mod.open_archive(
        write_rpa(tmp_path / "old.rpa", {"x/y.dat": blob}, version=2))
    assert arc.open("x/y.dat") == blob   # plain offsets, no XOR
    assert arc.version == 2


def test_corrupt_index_gives_clear_error(tmp_path: Path) -> None:
    path = write_rpa(tmp_path / "bad.rpa", {"g/a.rpy": b'"hi"\n'})
    with open(path, "r+b") as f:
        f.seek(-4, 2)
        f.write(b"\xff\xff\xff\xff")  # break the zlib stream tail
    with pytest.raises(rpa_mod.RpaError, match="corrupt RPA index"):
        rpa_mod.open_archive(path).names()


def test_not_an_rpa_rejected(tmp_path: Path) -> None:
    path = tmp_path / "nope.rpa"
    path.write_bytes(b"RENPY RPC2" + b"\x00" * 64)
    with pytest.raises(rpa_mod.RpaError, match="not an RPA archive"):
        rpa_mod.open_archive(path).names()


# --- scripts from archives feed the parser ------------------------------------

def _mp_like_game(tmp_path: Path) -> Path:
    """An archive-only game dir: no loose scripts, one scripts.rpa."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "scripts/a.rpy": b'label a\n    "first line"\n',
        "scripts/z.rpyc": FIXTURE_RPYC.read_bytes(),
    })
    return game


def test_archive_scripts_feed_parser(tmp_path: Path) -> None:
    game = _mp_like_game(tmp_path)
    parses, _defs, _chars, sources = parse_project(game)
    relnames = [rel for rel, _ in parses]
    assert relnames == ["game/scripts.rpa!scripts/a.rpy",
                        "game/scripts.rpa!scripts/z.rpyc"]  # filename order
    assert sum(len(p.events) for _, p in parses) > 0
    texts = [e.text for _, p in parses for e in p.events if e.kind
             == "dialogue"]
    assert "first line" in texts
    # The .rpyc member went through the vendored unrpyc decompile path.
    assert sources["rpaScripts"] == relnames
    assert any(rel.endswith("z.rpyc") for rel in sources["decompiled"])


def test_loose_script_wins_over_archive_member(tmp_path: Path) -> None:
    game = _mp_like_game(tmp_path)
    loose = game / "scripts" / "a.rpy"
    loose.parent.mkdir(parents=True)
    loose.write_text('label a\n    "loose wins"\n', encoding="utf-8")
    parses, _d, _c, sources = parse_project(game)
    assert "game/scripts.rpa!scripts/a.rpy" not in [r for r, _ in parses]
    assert sources["rpaIgnoredTwins"][0]["member"] == "scripts/a.rpy"


def test_cli_records_archive_scripts_in_ledger(tmp_path: Path) -> None:
    game = _mp_like_game(tmp_path)
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    assert any("!scripts/a.rpy" in s for s in ledger["inputs"])
    assert ledger["rpaScriptSources"]  # provenance recorded


# --- asset fallback ------------------------------------------------------------

def _archive_asset_game(tmp_path: Path) -> Path:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "script.rpy": (b'image room "bg/room.png"\n'
                       b'label start:\n    scene room\n    n "look"\n'),
    })
    write_rpa(game / "images.rpa", {"bg/room.png": tiny_png_bytes()})
    return game


def test_archive_asset_resolves_and_extracts(tmp_path: Path) -> None:
    game = _archive_asset_game(tmp_path)
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text())
    images = [i for i in manifest["items"] if i["type"] == "image"]
    assert len(images) == 1
    assert (out / images[0]["file"]).is_file()  # shipped via the pipeline
    cache_files = list((tmp_path / "extract-cache").glob("room-*.png"))
    assert cache_files, "member was streamed into the extraction cache"
    assert cache_files[0].read_bytes() == tiny_png_bytes()


def test_ledger_records_rpa_asset_provenance(tmp_path: Path) -> None:
    game = _archive_asset_game(tmp_path)
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    entry = next(e for e in ledger["items"].values()
                 if str(e["asset"]).startswith("rpa!"))
    assert entry["asset"] == "rpa!bg/room.png"
    assert entry["rpaSource"] == "rpa!bg/room.png"
    assert entry["rpaExtractedBytes"] == len(tiny_png_bytes())


def test_archive_asset_basename_match_across_dirs(tmp_path: Path) -> None:
    """Ren'Py-style base-name match: script names a bare file that the
    archive holds under a nested key."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "script.rpy": (b'image probe "room.png"\n'
                       b'label start:\n    scene probe\n    "x"\n'),
    })
    write_rpa(game / "images.rpa", {"gui/phone/room.png": tiny_png_bytes()})
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    entry = next(e for e in ledger["items"].values()
                 if str(e["asset"]).startswith("rpa!"))
    assert entry["asset"] == "rpa!gui/phone/room.png"


def test_loose_asset_wins_over_archive(tmp_path: Path) -> None:
    game = _archive_asset_game(tmp_path)
    loose = game / "bg"
    loose.mkdir()
    (loose / "room.png").write_bytes(tiny_png_bytes((10, 200, 10)))
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    assert not any(str(e["asset"]).startswith("rpa!")
                   for e in ledger["items"].values())
    assert not (tmp_path / "extract-cache").exists()
