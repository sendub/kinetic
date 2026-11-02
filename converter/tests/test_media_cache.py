"""Media reuse cache (docs/plan.md Phase 25, item 25.10).

A re-run with the same inputs and tools encodes nothing: every image
decision (JPEG XL tried and compared), transcode and poster comes from
``$KINETIC_MEDIA_CACHE``, and the output folder, ledger included, is
byte-identical to a cold run. A changed tool version, a changed recipe or
changed decoded bytes misses; a corrupt cached object misses and is
replaced. ``kinetic-media rebuild`` never reads the cache.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest

from kinetic_extract import assets, media_tools
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as extract_main
from kinetic_extract.media_cli import main as media_main
from test_media_rebuild import HOOK, HOOK_FILE, _build_project

# Every function an encode goes through: the image step runner (convert,
# JPEG XL), the file step runner (transcode, poster) and ffmpeg itself.
ENCODERS = [(assets, "run_image_step"), (assets, "run_file_step"),
            (assets, "ffmpeg_error"), (media_tools, "jxl_encode_lossless"),
            (media_tools, "jxl_recompress_jpeg")]


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "x-cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))
    cache = tmp_path / "media-cache"
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", str(cache))
    return cache


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """Every step kind: preserve, carve, convert, both JPEG XL modes,
    decode hook, copied and transcoded video with posters."""
    return _build_project(tmp_path / "proj", tmp_path)


def spy(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Count calls to every encoder (they still run)."""
    calls: list[str] = []
    for module, name in ENCODERS:
        original = getattr(module, name)

        def wrapper(*args, _o=original, _n=name, **kwargs):
            calls.append(_n)
            return _o(*args, **kwargs)
        monkeypatch.setattr(module, name, wrapper)
    return calls


def tree(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def extract(project: Path, out: Path, *extra: str) -> dict[str, bytes]:
    """A fresh kinetic-extract into `out` (same path every time, so the
    trees compare whole); returns the folder's files."""
    shutil.rmtree(out, ignore_errors=True)
    rpa_mod.reset_cache()
    assert extract_main([str(project), str(out), *extra]) == 0
    return tree(out)


def objects(cache: Path) -> list[Path]:
    return sorted(p for p in (cache / "objects").rglob("*") if p.is_file())


# --- warm runs encode nothing and match ------------------------------------

def test_second_extract_encodes_nothing_and_is_byte_identical(
        project: Path, tmp_path: Path, _caches: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    calls = spy(monkeypatch)
    cold = extract(project, out, "--decoder", HOOK)
    assert {"run_image_step", "run_file_step", "jxl_encode_lossless",
            "jxl_recompress_jpeg", "ffmpeg_error"} <= set(calls)
    assert objects(_caches)  # JPEG XL, convert, transcode, posters
    calls.clear()
    warm = extract(project, out, "--decoder", HOOK)
    assert calls == []
    assert warm == cold  # media, manifest and build-ledger.json


def test_disabled_cache_still_encodes(project: Path, tmp_path: Path,
                                      monkeypatch: pytest.MonkeyPatch,
                                      ) -> None:
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    out = tmp_path / "out"
    cold = extract(project, out, "--decoder", HOOK)
    calls = spy(monkeypatch)
    assert extract(project, out, "--decoder", HOOK) == cold
    assert "run_image_step" in calls and "ffmpeg_error" in calls


def _ship(project: Path, out: Path, requests: list[dict]) -> int:
    listing = out.parent / f"{out.name}.json"
    listing.write_text(json.dumps(requests), "utf-8")
    return media_main(["ship", str(project), str(out), "--list",
                       str(listing), "--decoder", HOOK])


SHIP = [{"source": {"path": "game/pics/photo.jpg"}, "kind": "image"},
        {"source": {"path": "game/pics/odd.bmp"}, "kind": "image"},
        {"source": {"path": "game/pics/hooked.png"}, "kind": "image"},
        {"source": {"path": "game/m.mp4"}, "kind": "video"}]


def test_ship_reuses_what_extract_encoded(project: Path, tmp_path: Path,
                                          monkeypatch: pytest.MonkeyPatch,
                                          ) -> None:
    extract(project, tmp_path / "out", "--decoder", HOOK)
    calls = spy(monkeypatch)
    assert _ship(project, tmp_path / "ship", SHIP) == 0
    assert calls == []
    cold_tree = tree(tmp_path / "ship")
    # The same ship with no cache gives the same folder.
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    shutil.rmtree(tmp_path / "ship")
    assert _ship(project, tmp_path / "ship", SHIP) == 0
    assert tree(tmp_path / "ship") == cold_tree
    assert calls


# --- misses ------------------------------------------------------------------

def test_changed_tool_version_misses(project: Path, tmp_path: Path,
                                     monkeypatch: pytest.MonkeyPatch,
                                     ) -> None:
    out = tmp_path / "out"
    extract(project, out)
    real = media_tools.python_versions
    monkeypatch.setattr(media_tools, "python_versions",
                        lambda: {**real(), "libjxl": "0.0.0-other"})
    calls = spy(monkeypatch)
    extract(project, out)
    assert "jxl_encode_lossless" in calls and "ffmpeg_error" in calls


def test_changed_jxl_recipe_misses(project: Path, tmp_path: Path,
                                   monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    extract(project, out)
    monkeypatch.setattr(media_tools, "JXL_EFFORT", 7)
    calls = spy(monkeypatch)
    extract(project, out)
    assert "jxl_encode_lossless" in calls
    assert "ffmpeg_error" not in calls  # video recipes unchanged: hits


def test_changed_poster_recipe_misses(project: Path, tmp_path: Path,
                                      monkeypatch: pytest.MonkeyPatch,
                                      ) -> None:
    out = tmp_path / "out"
    extract(project, out)
    monkeypatch.setattr(assets, "POSTER_JPEG_QUALITY", 80)
    calls = spy(monkeypatch)
    extract(project, out)
    assert "ffmpeg_error" in calls
    assert "run_image_step" not in calls  # image recipes unchanged: hits


def test_corrupt_object_misses_and_is_replaced(
        project: Path, tmp_path: Path, _caches: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    cold = extract(project, out, "--decoder", HOOK)
    stored = objects(_caches)
    good = {p: p.read_bytes() for p in stored}
    for path in stored:
        path.write_bytes(b"not what it was")
    calls = spy(monkeypatch)
    assert extract(project, out, "--decoder", HOOK) == cold
    assert "jxl_encode_lossless" in calls and "ffmpeg_error" in calls
    for path, data in good.items():
        assert path.read_bytes() == data
        assert hashlib.sha256(data).hexdigest() == path.name
    calls.clear()
    assert extract(project, out, "--decoder", HOOK) == cold
    assert calls == []


def test_corrupt_memo_misses(project: Path, tmp_path: Path, _caches: Path,
                             monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    cold = extract(project, out)
    for memo in (_caches / "memo").rglob("*.json"):
        memo.write_text("{not json", "utf-8")
    calls = spy(monkeypatch)
    assert extract(project, out) == cold
    assert "jxl_encode_lossless" in calls


def _hook_copy(tmp_path: Path, name: str, body: str) -> str:
    path = tmp_path / f"{name}.py"
    path.write_text(HOOK_FILE.read_text("utf-8") + body, "utf-8")
    return f"{path}:decode"


def test_hook_whose_output_changes_misses(project: Path, tmp_path: Path,
                                          monkeypatch: pytest.MonkeyPatch,
                                          ) -> None:
    out = tmp_path / "out"
    extract(project, out, "--decoder", HOOK)
    # Same wrapper, but the decoded image's colours are inverted.
    other = _hook_copy(tmp_path, "flip_hook", '''

_decode = decode


def decode(data, source):
    from io import BytesIO
    from PIL import Image
    out = _decode(data, source)
    if out is None:
        return None
    with Image.open(BytesIO(out)) as img:
        buf = BytesIO()
        Image.eval(img.convert("RGB"), lambda v: 255 - v).save(buf, "PNG")
    return buf.getvalue()
''')
    calls = spy(monkeypatch)
    extract(project, out, "--decoder", other)
    assert calls.count("run_image_step") == 1  # the hooked image only


def test_hook_with_new_code_but_same_output_hits(
        project: Path, tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    extract(project, out, "--decoder", HOOK)
    other = _hook_copy(tmp_path, "same_hook", "\n# reworded, same output\n")
    calls = spy(monkeypatch)
    extract(project, out, "--decoder", other)
    assert calls == []
    # The ledger records the hook that ran now, not the cached one's.
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    decode_steps = [s for e in ledger["media"].values()
                    for s in e["steps"] if s["step"] == "decode"]
    new_sha = hashlib.sha256(
        (tmp_path / "same_hook.py").read_bytes()).hexdigest()
    assert decode_steps
    assert {s["hookSha256"] for s in decode_steps} == {new_sha}


# --- rebuild never trusts the cache --------------------------------------------

def test_rebuild_reencodes_with_a_warm_cache(
        project: Path, tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    extract(project, out, "--decoder", HOOK)
    calls = spy(monkeypatch)
    assert media_main(["rebuild", str(project), str(out),
                       "--decoder", HOOK]) == 0
    assert {"jxl_encode_lossless", "jxl_recompress_jpeg",
            "run_file_step"} <= set(calls)
