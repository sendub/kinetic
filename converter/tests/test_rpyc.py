"""Compiled-only `.rpyc` support tests (docs/plan.md Phase 11, item 2).

Covers the vendored-unrpyc integration: decompiling a real `.rpyc` to text
the parser accepts, the `.rpy`-wins-over-stale-`.rpyc` twin rule, and that
the build ledger records decompiled sources. No Ren'Py is required: the
vendored `decompiler` fabricates the Ren'Py modules via
``magic.fake_package`` (see converter/vendor/SOURCES.md).

Fixture: ``data/credits.rpyc`` is a byte-for-byte copy of a corpus
game's ``Contents/Resources/autorun/game/credits.rpyc`` (8228 B, the
smallest script `.rpyc` in that compiled-only game, game D of
docs/extracting.md's survey; RPyC v2 header ``RENPY RPC2``). unrpyc only decompiles (it cannot
compile), so a real compiled file is checked in rather than built here.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from kinetic_extract import rpyc as rpyc_mod
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_file, parse_project

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_RPYC = Path(__file__).parent / "data" / "credits.rpyc"


# --- decompile: vendored unrpyc produces parser-consumable text ---------

def test_rpyc_fixture_decompiles_to_parseable_text(tmp_path: Path) -> None:
    assert FIXTURE_RPYC.is_file() and FIXTURE_RPYC.stat().st_size < 200 * 1024
    text = rpyc_mod.decompile_text(FIXTURE_RPYC, cache_dir=tmp_path)
    # Decompiled text is real .rpy source the parser can walk.
    parsed = parse_file(text, "game/credits.rpyc")
    assert len(parsed.events) > 0
    labels = [e.name for e in parsed.events if e.kind == "label"]
    assert "credits" in labels  # label name visible in decompiled output


def test_decompile_cache_reuses_and_is_keyed_by_file(tmp_path: Path) -> None:
    cache = tmp_path / "cache"
    first = rpyc_mod.decompile_text(FIXTURE_RPYC, cache_dir=cache)
    cached = list(cache.glob("credits.rpyc.*.rpy"))
    assert len(cached) == 1, "one cache entry per (path, mtime, size)"
    # Cache hit returns identical text without touching unrpyc.
    second = rpyc_mod.decompile_text(FIXTURE_RPYC, cache_dir=cache)
    assert second == first
    # A distinct file yields a distinct cache key (not reused).
    other = tmp_path / "other.rpyc"
    shutil.copyfile(FIXTURE_RPYC, other)
    rpyc_mod.decompile_text(other, cache_dir=cache)
    names = sorted(cache.glob("*.rpy"))
    assert len(names) == 2  # credits.rpyc and other.rpyc cached separately


# --- twin preference: a stale .rpyc never overrides its .rpy --------------

def test_rpy_wins_over_stale_rpyc_twin(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    # A .rpy whose only label is unique, and a stale .rpyc for the same
    # stem that would (wrongly) contribute a different label if used.
    (game / "script.rpy").write_text("label rpy_won:\n    \"kept\"\n",
                                      encoding="utf-8")
    shutil.copyfile(FIXTURE_RPYC, game / "script.rpyc")  # decompiles to `label credits`
    parses, _img, _chars, sources = parse_project(game, cache_dir=tmp_path)

    rels = [rel for rel, _ in parses]
    assert rels == ["game/script.rpy"]  # the .rpyc was not parsed
    events = [e for _, p in parses for e in p.events]
    labels = [e.name for e in events if e.kind == "label"]
    assert labels == ["rpy_won"]
    assert "credits" not in labels
    assert sources["decompiled"] == []
    assert sources["ignoredTwins"] == [
        {"rpyc": "game/script.rpyc", "kept": "game/script.rpy"}]


# --- compiled-only project: unrpyc feeds the parser, ledger records it ----

def test_compiled_only_project_parses_without_rpy(tmp_path: Path) -> None:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    shutil.copyfile(FIXTURE_RPYC, game / "credits.rpyc")
    parses, _img, _chars, sources = parse_project(game, cache_dir=tmp_path)

    assert [rel for rel, _ in parses] == ["game/credits.rpyc"]
    assert sources["decompiled"] == ["game/credits.rpyc"]
    assert sources["ignoredTwins"] == [] and sources["failed"] == []
    labels = [e.name for _, p in parses for e in p.events
              if e.kind == "label"]
    assert "credits" in labels


def test_cli_records_rpyc_source_in_ledger(tmp_path: Path,
                                           monkeypatch) -> None:
    cache = tmp_path / "cache"
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(cache))
    game = tmp_path / "Game.app" / "Contents" / "Resources" / "autorun" / "game"
    game.mkdir(parents=True)
    shutil.copyfile(FIXTURE_RPYC, game / "credits.rpyc")
    # BUG 1: a scene whose name answers no file is dropped, not shipped
    # as a placeholder — so the project holds one real loose asset (the
    # shape the real game D has) for the flow to produce items,
    # resolved implicitly by name (BUG 5).
    from PIL import Image

    (game / "images").mkdir()
    Image.new("RGB", (16, 9), "navy").save(game / "images" / "credits_1.png")
    out = tmp_path / "out"

    assert cli_main([str(tmp_path / "Game.app"), str(out)]) == 0

    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    assert len(manifest["items"]) > 0  # decompiled flow produced items
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert ledger["inputs"] == ["game/credits.rpyc"]
    assert ledger["rpycSources"] == ["game/credits.rpyc"]
    assert any(str(item["source"]).startswith("game/credits.rpyc:")
               for item in ledger["items"].values())
