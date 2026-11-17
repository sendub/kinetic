"""`.rpa` archive reader tests (docs/plan.md Phase 11, item 3).

The archives are BUILT IN-TEST by a writer helper matching the format
verified against the corpus: `RPA-3.0 <index_offset:16hex> <xor_key:8hex>\\n`
with a zlib+pickle index at the tail whose (offset, length) pairs are
XOR-obfuscated with the header key, and `RPA-2.0 <index_offset:16hex>\\n`
with plain offsets; member bytes are stored uncompressed. No test touches
the Ren'Py corpus.

Covered: round-trip read of a tiny archive, corrupt-index error,
archive `.rpy`/`.rpyc` members feeding the parser (with the synthetic
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


def _dialogue(parses) -> list[str]:
    return [e.text for _, p in parses for e in p.events
            if e.kind == "dialogue"]


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
    # A walked loose script (top level of game/) beats the archive member
    # with its key. Before item 9d this test put the loose file in a
    # subfolder, which the walk never reads: that shadowing lost the
    # script (test_unwalked_loose_script_does_not_shadow_the_archive).
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {"a.rpy": b'label a\n    "archived"\n'})
    (game / "a.rpy").write_text('label a\n    "loose wins"\n',
                                encoding="utf-8")
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/a.rpy"]
    assert _dialogue(parses) == ["loose wins"]
    assert sources["rpaIgnoredTwins"][0]["member"] == "a.rpy"


def test_cli_records_archive_scripts_in_ledger(tmp_path: Path) -> None:
    game = _mp_like_game(tmp_path)
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    assert any("!scripts/a.rpy" in s for s in ledger["inputs"])
    assert ledger["rpaScriptSources"]  # provenance recorded


# --- .rpy/.rpyc pairs: one source per path (item 9c) ---------------------------

# The .rpy of a pair; its .rpyc twin is the credits fixture, whose lines
# differ, so a walked twin shows as extra dialogue.
_PAIR_RPY = b'label credits:\n    nr "From the source."\n'


def test_archive_pair_walks_only_the_rpy(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    write_rpa(game / "scripts.rpa", {
        "credits.rpy": _PAIR_RPY,
        "credits.rpyc": FIXTURE_RPYC.read_bytes(),
    })
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/scripts.rpa!credits.rpy"]
    assert _dialogue(parses) == ["From the source."]
    assert sources["decompiled"] == []      # the twin cost no decompile
    assert sources["rpaIgnoredTwins"] == [{
        "member": "credits.rpyc", "archive": "game/scripts.rpa",
        "reason": "a .rpy with the same path",
        "kept": "game/scripts.rpa!credits.rpy"}]


def test_pair_split_across_archives_walks_only_the_rpy(
        tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    # The .rpyc's archive sorts first; the .rpy still wins.
    write_rpa(game / "a.rpa", {
        "scripts/credits.rpyc": FIXTURE_RPYC.read_bytes()})
    write_rpa(game / "b.rpa", {"scripts/credits.rpy": _PAIR_RPY})
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/b.rpa!scripts/credits.rpy"]
    assert sources["decompiled"] == []
    [skipped] = sources["rpaIgnoredTwins"]
    assert (skipped["member"], skipped["kept"]) == (
        "scripts/credits.rpyc", "game/b.rpa!scripts/credits.rpy")


def test_loose_rpy_beats_archived_rpyc(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "credits.rpy").write_bytes(_PAIR_RPY)
    write_rpa(game / "scripts.rpa", {
        "credits.rpyc": FIXTURE_RPYC.read_bytes()})
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/credits.rpy"]
    assert sources["decompiled"] == []
    assert sources["rpaIgnoredTwins"][0]["kept"] == "game/credits.rpy"


def test_archived_rpy_beats_loose_rpyc(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "credits.rpyc").write_bytes(FIXTURE_RPYC.read_bytes())
    write_rpa(game / "scripts.rpa", {"credits.rpy": _PAIR_RPY})
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/scripts.rpa!credits.rpy"]
    assert sources["decompiled"] == []
    assert sources["ignoredTwins"] == [{
        "rpyc": "game/credits.rpyc", "kept": "game/scripts.rpa!credits.rpy"}]


def test_loose_file_beats_archived_file_with_the_same_path(
        tmp_path: Path) -> None:
    """A loose pair beats the same pair archived: only the loose .rpy is
    walked, and both members are reported as skipped."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "credits.rpy").write_text(
        'label credits:\n    nr "Loose."\n', encoding="utf-8")
    (game / "credits.rpyc").write_bytes(FIXTURE_RPYC.read_bytes())
    write_rpa(game / "scripts.rpa", {
        "credits.rpy": _PAIR_RPY,
        "credits.rpyc": FIXTURE_RPYC.read_bytes()})
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/credits.rpy"]
    assert _dialogue(parses) == ["Loose."]
    assert sources["decompiled"] == []
    assert [(s["member"], s["reason"]) for s in sources["rpaIgnoredTwins"]
            ] == [("credits.rpy", "loose file with the same key"),
                  ("credits.rpyc", "loose file with the same key")]


def test_unpaired_archived_rpyc_is_still_decompiled(tmp_path: Path) -> None:
    game = _mp_like_game(tmp_path)   # a.rpy and an unrelated z.rpyc
    _parses, _d, _c, sources = parse_project(game)
    assert sources["decompiled"] == ["game/scripts.rpa!scripts/z.rpyc"]
    assert sources["rpaIgnoredTwins"] == []


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
                 if "!" in str(e["asset"]))
    assert entry["asset"] == "game/images.rpa!bg/room.png"
    source = ledger["media"][entry["file"]]["source"]
    assert source["archive"] == "game/images.rpa"
    assert source["member"] == "bg/room.png"
    assert source["bytes"] == len(tiny_png_bytes())


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
                 if "!" in str(e["asset"]))
    assert entry["asset"] == "game/images.rpa!gui/phone/room.png"


def test_loose_asset_wins_over_archive(tmp_path: Path) -> None:
    game = _archive_asset_game(tmp_path)
    loose = game / "bg"
    loose.mkdir()
    (loose / "room.png").write_bytes(tiny_png_bytes((10, 200, 10)))
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text())
    assert not any("!" in str(e["asset"])
                   for e in ledger["items"].values())
    assert not (tmp_path / "extract-cache").exists()


# --- walk scope: only walked scripts shadow (item 9d) ------------------------

def test_unwalked_loose_script_does_not_shadow_the_archive(
        tmp_path: Path) -> None:
    """A loose script in a subfolder of game/ is not walked (the walk reads
    the top level), so the archived script with its key is walked."""
    game = _mp_like_game(tmp_path)      # scripts/a.rpy, scripts/z.rpyc
    loose = game / "scripts" / "a.rpy"
    loose.parent.mkdir(parents=True)
    loose.write_text('label a\n    "never walked"\n', encoding="utf-8")
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/scripts.rpa!scripts/a.rpy",
                                      "game/scripts.rpa!scripts/z.rpyc"]
    assert "first line" in _dialogue(parses)
    assert "never walked" not in _dialogue(parses)
    assert sources["rpaIgnoredTwins"] == []


def test_unwalked_loose_rpy_does_not_beat_an_archived_rpyc(
        tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    (game / "scripts").mkdir(parents=True)
    (game / "scripts" / "credits.rpy").write_bytes(_PAIR_RPY)
    write_rpa(game / "scripts.rpa", {
        "scripts/credits.rpyc": FIXTURE_RPYC.read_bytes()})
    parses, _d, _c, sources = parse_project(game)
    assert [r for r, _ in parses] == ["game/scripts.rpa!scripts/credits.rpyc"]
    assert sources["decompiled"] == ["game/scripts.rpa!scripts/credits.rpyc"]
    assert sources["rpaIgnoredTwins"] == []


def test_files_reaching_a_subfolder_walks_and_shadows(tmp_path: Path) -> None:
    """--files can reach a subfolder; the loose scripts it reaches are
    walked and beat the archive, .rpyc twins included."""
    game = _mp_like_game(tmp_path)
    (game / "scripts").mkdir()
    (game / "scripts" / "a.rpy").write_text('label a\n    "loose"\n',
                                            encoding="utf-8")
    (game / "scripts" / "a.rpyc").write_bytes(FIXTURE_RPYC.read_bytes())
    parses, _d, _c, sources = parse_project(game, "scripts/*.rpy")
    assert [r for r, _ in parses] == ["game/scripts/a.rpy",
                                      "game/scripts.rpa!scripts/z.rpyc"]
    assert sources["ignoredTwins"] == [
        {"rpyc": "game/scripts/a.rpyc", "kept": "game/scripts/a.rpy"}]
    assert sources["rpaIgnoredTwins"] == [{
        "member": "scripts/a.rpy", "archive": "game/scripts.rpa",
        "reason": "loose file with the same key"}]


# --- --files: archive members follow the loose rule (item 9d) ----------------

@pytest.mark.parametrize("where", ["loose", "archived"])
def test_rpy_pattern_takes_a_compiled_only_script(tmp_path: Path,
                                                  where: str) -> None:
    """`--files "*.rpy"` takes a .rpyc that has no .rpy, loose or
    archived alike (archives used to drop it)."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    if where == "loose":
        (game / "credits.rpyc").write_bytes(FIXTURE_RPYC.read_bytes())
        rel = "game/credits.rpyc"
    else:
        write_rpa(game / "scripts.rpa", {
            "credits.rpyc": FIXTURE_RPYC.read_bytes()})
        rel = "game/scripts.rpa!credits.rpyc"
    for pattern in ("*.rpy", "credits.rpy", "cred*"):
        parses, _d, _c, sources = parse_project(game, pattern)
        assert [r for r, _ in parses] == [rel], pattern
        assert sources["decompiled"] == [rel]
    parses, _d, _c, _s = parse_project(game, "other.rpy")
    assert parses == []


@pytest.mark.parametrize("where", ["loose", "archived"])
def test_files_pattern_on_a_pair_walks_the_rpy(tmp_path: Path,
                                               where: str) -> None:
    """A pattern choosing both halves of a pair walks the .rpy and lists
    the .rpyc as skipped, loose or archived alike; a pattern with no
    extension never reads a .rpyc as text."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    pair = {"credits.rpy": _PAIR_RPY,
            "credits.rpyc": FIXTURE_RPYC.read_bytes()}
    if where == "loose":
        for name, blob in pair.items():
            (game / name).write_bytes(blob)
        rpy, rpyc, skipped = "game/credits.rpy", "game/credits.rpyc", \
            "ignoredTwins"
    else:
        write_rpa(game / "scripts.rpa", pair)
        rpy, rpyc, skipped = ("game/scripts.rpa!credits.rpy",
                              "game/scripts.rpa!credits.rpyc",
                              "rpaIgnoredTwins")
    for pattern in ("*.rpy", "credits.rpy", "cred*", "*"):
        parses, _d, _c, sources = parse_project(game, pattern)
        assert [r for r, _ in parses] == [rpy], pattern
        assert _dialogue(parses) == ["From the source."]
        assert sources["decompiled"] == []
        [twin] = sources[skipped]
        assert twin.get("rpyc", f"game/scripts.rpa!{twin.get('member')}") \
            == rpyc and twin["kept"] == rpy
    # A .rpyc pattern chooses the compiled half, which still loses to
    # its .rpy: nothing is walked, and nothing is read as text.
    parses, _d, _c, sources = parse_project(game, "*.rpyc")
    assert parses == [] and sources["decompiled"] == []
    assert len(sources[skipped]) == 1


def test_rpyc_pattern_decompiles_a_loose_rpyc(tmp_path: Path) -> None:
    """`--files "*.rpyc"` decompiles the file (it used to be read as a
    .rpy's text as well)."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "credits.rpyc").write_bytes(FIXTURE_RPYC.read_bytes())
    parses, _d, _c, sources = parse_project(game, "*.rpyc")
    assert [r for r, _ in parses] == ["game/credits.rpyc"]
    assert sources["decompiled"] == ["game/credits.rpyc"]
    assert sources["failed"] == []


# --- the asset name index (item 9d) ------------------------------------------

def _scan_candidates(archives, rel: str, kind: str) -> list:
    """AssetArchives.candidates as it was before item 9d: a scan of every
    key of every archive per call. The index must answer exactly this."""
    from kinetic_extract.media import IMAGE_EXTS, VIDEO_EXTS
    if not archives:
        return []
    kind_exts = [f".{e}" for e in (IMAGE_EXTS if kind == "image"
                                   else VIDEO_EXTS)]
    stem = str(Path(rel).with_suffix(""))
    out, seen = [], set()

    def add(arc, key):
        if key not in seen:
            seen.add(key)
            out.append((arc, key))

    for arc in archives:
        if rel in arc:
            add(arc, rel)
    for ext in sorted(kind_exts):
        for arc in archives:
            if stem + ext in arc:
                add(arc, stem + ext)
    for arc in archives:
        for key in arc.index():
            if Path(key).with_suffix("") == Path(stem):
                add(arc, key)
    base = Path(stem).name
    cands = []
    for arc in archives:
        for key in arc.index():
            kp = Path(key)
            if kp.name == base or kp.with_suffix("").name == base:
                rank = 0 if Path(key).suffix.lower() in kind_exts else 1
                cands.append((rank, len(key), key, arc))
    cands.sort(key=lambda c: (c[0], c[1], c[2], c[3].path.name))
    for _rank, _len, key, arc in cands:
        add(arc, key)
    return out


_TRICKY = {
    "a.rpa": ["images/beach.png", "images/Beach.png", "images/beach.jpg",
              "bg/beach.webp", "beach", "beach.PNG", "images/beach.png.bak",
              "Ana.webp", "chars/ana.webp", "chars/ana/happy.png",
              "video/op.webm", "video/op.mp4", "op.WEBM", "./dot/x.png",
              "a.b/c", "a.b/c.png", "x.tar.gz", "scripts/a.rpy",
              "audio/beach.ogg", "images/sub dir/beach 00001.jpg",
              ".hidden.png", "trail.", "two..dots.png", "a/.png"],
    "b.rpa": ["images/beach.png", "beach.gif", "chars/ana.webp",
              "video/op.webm", "Op.webm", "images/beach 00001.jpg",
              "dot/x.jpg", "x.tar"],
    "c.rpa": ["bg/beach.webp", "ana.png", "images/beach.webm",
              "video/OP.mkv", "beach 00001.png"],
}


def test_asset_index_answers_as_the_scan_did(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    for name, keys in _TRICKY.items():
        write_rpa(game / name, {k: k.encode() for k in keys})
    archives = rpa_mod.AssetArchives(game)
    loaded = archives._load()
    queries = {"beach", "Beach", "images/beach", "images/beach.gif",
               "images/beach.bmp", "bg/beach.png", "ana", "chars/ana",
               "Ana", "op", "Op", "video/op", "video/op.mkv", "missing",
               "missing.png", "dot/x", "./dot/x.png", "a.b/c", "x.tar", "x",
               "beach 00001", "images/sub dir/beach 00001", "trail",
               "trail.", "two..dots", ".hidden", ".png", "happy",
               "chars/ana/happy", "beach.png.bak", "images/beach.png"}
    for keys in _TRICKY.values():
        for key in keys:
            kp = Path(key)
            queries |= {key, str(kp.with_suffix("")), kp.name,
                        kp.with_suffix("").name, key.upper(), key.lower()}
    hits = 0
    for rel in sorted(queries):
        for kind in ("image", "video"):
            want = _scan_candidates(loaded, rel, kind)
            got = archives.candidates(rel, kind)
            assert [(a.path.name, k) for a, k in got] == [
                (a.path.name, k) for a, k in want], (rel, kind)
            hits += len(got) > 1
    assert hits > 20        # the set exercises ordering, not only misses


def test_asset_index_with_no_readable_archive(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    assert rpa_mod.AssetArchives(game).candidates("beach", "image") == []
    (game / "bad.rpa").write_bytes(b"not an archive")
    archives = rpa_mod.AssetArchives(game)
    assert archives.candidates("beach", "image") == []
    assert [f["archive"] for f in archives.failed] == ["bad.rpa"]
