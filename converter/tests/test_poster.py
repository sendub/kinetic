"""Poster recipes and poster failure (docs/plan.md Phase 25, item 25.7).

A video's poster is the frame at its ``startSeconds``, written by ffmpeg
as a bitexact PNG and saved by Pillow as an RGB JPEG. The ledger's
``poster`` step holds everything that decides those bytes, so running
the recorded step again on the source makes the same file. When the
poster cannot be made, the video item is dropped (nothing ships for it)
and reported with the source and ffmpeg's error, never shipped with the
video standing in as its own poster.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

import pytest

from kinetic_extract import assets, media_tools
from kinetic_extract.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
sys.path.insert(0, str(REPO_ROOT / "tools"))
import validate_content  # noqa: E402

FFMPEG_ERROR = "Invalid data found when processing input"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _encode(out: Path, *args: str) -> Path:
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1", *args, str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


@pytest.fixture(scope="module")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("poster-clips")
    return {
        # copied unchanged
        "h264.mp4": _encode(d / "h264.mp4", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p"),
        # transcoded
        "mpeg4.mp4": _encode(d / "mpeg4.mp4", "-c:v", "mpeg4"),
    }


def _fail_frame_step(monkeypatch: pytest.MonkeyPatch) -> None:
    """ffmpeg fails the poster's frame step (and only that step)."""
    real = assets.ffmpeg_error

    def fake(args: list[str], source: Path, out: Path) -> str | None:
        if "-frames:v" in args:
            return FFMPEG_ERROR
        return real(args, source, out)

    monkeypatch.setattr(assets, "ffmpeg_error", fake)


def _game(tmp_path: Path, name: str, data: bytes) -> Path:
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / name).write_bytes(data)
    (game / "script.rpy").write_text(
        f'label start:\n    movie "{name}"\n    "Playing."\n',
        encoding="utf-8")
    return game.parent


@pytest.mark.parametrize("name", ["h264.mp4", "mpeg4.mp4"])
def test_failed_poster_drops_the_video_and_reports_it(
        tmp_path: Path, clips: dict[str, Path], name: str,
        monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    _fail_frame_step(monkeypatch)
    project = _game(tmp_path, "m.mp4", clips[name].read_bytes())
    out = tmp_path / "out"
    capsys.readouterr()
    assert cli_main([str(project), str(out)]) == 0
    summary = capsys.readouterr().out
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))

    # Dropped: no video item, no poster anywhere, nothing shipped for it.
    assert [i for i in manifest["items"] if i["type"] == "video"] == []
    assert not any("poster" in i for i in manifest["items"])
    assert ledger["media"] == {}
    assert not (out / "media").exists() or not any(
        p.is_file() for p in (out / "media").rglob("*"))

    # Reported: ledger item entry, its note, a summary warning, the count.
    (vid_id, entry), = [(k, e) for k, e in ledger["items"].items()
                        if e["asset"] == "game/m.mp4"]
    assert entry["decision"] == "skipped"
    assert "file" not in entry and "poster" not in entry
    note = next(n for n in entry["notes"] if "poster" in n)
    assert "game/m.mp4" in note and FFMPEG_ERROR in note
    assert "dropped" in note
    assert entry["warning"] == note
    warnings = [ln for ln in summary.splitlines()
                if ln.startswith("warning:")]
    assert len(warnings) == 1
    assert vid_id in warnings[0] and FFMPEG_ERROR in warnings[0]
    assert "items skipped: 1" in summary
    assert "media shipped: 0" in summary

    assert validate_content.validate_folder(out) == []


def test_failed_poster_of_a_shared_video_reports_each_item(
        tmp_path: Path, clips: dict[str, Path],
        monkeypatch: pytest.MonkeyPatch) -> None:
    """Two items play the same bytes: when the frame step fails, both
    are dropped and the failure is reported for each."""
    _fail_frame_step(monkeypatch)
    data = clips["h264.mp4"].read_bytes()
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "a.mp4").write_bytes(data)
    (game / "b.mp4").write_bytes(data)
    (game / "script.rpy").write_text(
        'label start:\n    movie "a.mp4"\n    "One."\n'
        '    movie "b.mp4"\n    "Two."\n', encoding="utf-8")
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert [i for i in manifest["items"] if i["type"] == "video"] == []
    assert ledger["media"] == {}
    for asset in ("game/a.mp4", "game/b.mp4"):
        (entry,) = [e for e in ledger["items"].values()
                    if e["asset"] == asset]
        assert entry["decision"] == "skipped"
        assert any(asset in n and FFMPEG_ERROR in n for n in entry["notes"])
    assert validate_content.validate_folder(out) == []


def test_ffmpeg_error_names_the_real_failure(tmp_path: Path) -> None:
    """The error text is ffmpeg's own stderr, not a generic word."""
    bad = tmp_path / "bad.mp4"
    bad.write_bytes(b"\x00" * 64)
    error = assets.ffmpeg_error(assets.frame_args(0.0), bad,
                                tmp_path / "f.png")
    assert error is not None and "Invalid data" in error
    assert str(tmp_path) not in error  # paths are named by the caller
    ok = assets.ffmpeg_error(
        assets.frame_args(0.0), FIXTURE / "game" / "data" / "clip.mp4",
        tmp_path / "g.png")
    assert ok is None and (tmp_path / "g.png").is_file()


@pytest.fixture(scope="module")
def demo(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict, dict]:
    out = tmp_path_factory.mktemp("demo") / "out"
    assert cli_main([str(FIXTURE), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return out, manifest, ledger


def test_every_shipped_poster_has_a_complete_recipe(demo) -> None:
    _, manifest, ledger = demo
    posters = [i["poster"] for i in manifest["items"] if "poster" in i]
    assert posters
    for ref in posters:
        entry = ledger["media"][ref]
        assert entry["kind"] == "poster"
        (step,) = entry["steps"]
        assert set(step) == {"step", "startSeconds", "args", "frameFormat",
                             "mode", "jpeg"}
        assert step["frameFormat"] == "png" and step["mode"] == "RGB"
        assert step["args"] == assets.frame_args(step["startSeconds"])
        assert set(entry["tools"]) == {"ffmpeg", "Pillow"}


def test_poster_recipe_rerun_from_the_ledger_gives_the_same_bytes(
        demo, tmp_path: Path) -> None:
    out, manifest, ledger = demo
    for item in (i for i in manifest["items"] if "poster" in i):
        entry = ledger["media"][item["poster"]]
        source = FIXTURE / entry["source"]["path"]
        assert hashlib.sha256(source.read_bytes()).hexdigest() == \
            entry["source"]["sha256"]
        (step,) = entry["steps"]
        remade = tmp_path / "remade.jpg"
        assert assets.run_poster_step(step, source, remade) is None
        data = remade.read_bytes()
        assert data == (out / item["poster"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry["sha256"]
