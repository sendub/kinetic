"""Video policy (docs/plan.md Phase 25, item 25.6): any MKV source ships
byte-identical, whatever its codecs, with a ledger `preserve` step that
records the codec. An MKV whose video codec no target browser plays is
still copied, never transcoded, but the converter warns in the summary
and adds an item note. Other containers keep their policy: MP4/MOV with
H.264/HEVC and WebM with VP8/VP9/AV1 copy, anything else transcodes to
H.264 MP4.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from kinetic_extract import media_tools
from kinetic_extract.cli import main as cli_main


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def _encode(out: Path, *args: str) -> Path:
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=64x36:rate=10:duration=1",
         "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
         *args, "-shortest", str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


@pytest.fixture(scope="module")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")
    return {
        "h264.mkv": _encode(d / "h264.mkv", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-c:a", "aac"),
        "mpeg4.mkv": _encode(d / "mpeg4.mkv", "-c:v", "mpeg4",
                             "-c:a", "aac"),
        "vp9.webm": _encode(d / "vp9.webm", "-c:v", "libvpx-vp9",
                            "-c:a", "libopus"),
        "h264.mp4": _encode(d / "h264.mp4", "-c:v", "libx264",
                            "-pix_fmt", "yuv420p", "-c:a", "aac"),
        "mpeg4.mp4": _encode(d / "mpeg4.mp4", "-c:v", "mpeg4",
                             "-c:a", "aac"),
    }


def convert_one(tmp_path: Path, name: str, data: bytes,
                capsys: pytest.CaptureFixture[str],
                ) -> tuple[dict, dict, dict, str]:
    """Convert a one-movie game; (video item, its ledger item entry, its
    ledger media entry, the printed summary)."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / name).write_bytes(data)
    (game / "script.rpy").write_text(
        f'label start:\n    movie "{name}"\n    "Playing."\n',
        encoding="utf-8")
    out = tmp_path / "out"
    capsys.readouterr()
    assert cli_main([str(game.parent), str(out)]) == 0
    summary = capsys.readouterr().out
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    (video,) = [i for i in manifest["items"] if i["type"] == "video"]
    item_entry = ledger["items"][video["id"]]
    media_entry = ledger["media"][video["file"]]
    return video, item_entry, media_entry, summary


def _shipped(tmp_path: Path, video: dict) -> bytes:
    return (tmp_path / "out" / video["file"]).read_bytes()


def test_mkv_h264_ships_byte_identical_with_preserve_step(
        tmp_path: Path, clips: dict[str, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips["h264.mkv"].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, "m.mkv", data,
                                              capsys)
    assert _shipped(tmp_path, video) == data
    digest = hashlib.sha256(data).hexdigest()
    assert video["file"] == f"media/{digest[:2]}/{digest}.mkv"
    assert entry["steps"] == [{"step": "preserve", "codec": "h264"}]
    assert "tools" not in entry
    assert item["decision"] == "copy"
    assert item["sniffedFormat"] == "mkv"
    assert item["codec"] == "h264"
    assert "warning" not in item
    assert "no target browser" not in summary


def test_mkv_unplayable_codec_ships_byte_identical_with_warning(
        tmp_path: Path, clips: dict[str, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips["mpeg4.mkv"].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, "m.mkv", data,
                                              capsys)
    assert _shipped(tmp_path, video) == data
    assert video["file"].endswith(".mkv")
    assert entry["steps"] == [{"step": "preserve", "codec": "mpeg4"}]
    assert item["decision"] == "copy"
    note = "MKV codec mpeg4: no target browser plays it"
    assert note in item["notes"]
    assert item["warning"] == note
    warning_lines = [ln for ln in summary.splitlines()
                     if ln.startswith("warning:")]
    assert len(warning_lines) == 1 and note in warning_lines[0]
    assert video["id"] in warning_lines[0]


def test_matroska_named_otherwise_is_still_mkv(
        tmp_path: Path, clips: dict[str, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    """Content decides, not the extension: Matroska bytes named .mp4
    are an MKV source (copied unchanged, shipped as .mkv)."""
    data = clips["mpeg4.mkv"].read_bytes()
    video, item, entry, _ = convert_one(tmp_path, "m.mp4", data, capsys)
    assert _shipped(tmp_path, video) == data
    assert video["file"].endswith(".mkv")
    assert item["sniffedFormat"] == "mkv"
    assert entry["steps"] == [{"step": "preserve", "codec": "mpeg4"}]


@pytest.mark.parametrize("name", ["vp9.webm", "h264.mp4"])
def test_native_webm_and_mp4_still_copy(
        tmp_path: Path, clips: dict[str, Path], name: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips[name].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, name, data, capsys)
    assert _shipped(tmp_path, video) == data
    assert video["file"].endswith("." + name.rsplit(".", 1)[1])
    assert entry["steps"][0]["step"] == "preserve"
    assert item["decision"] == "copy"
    assert "warning:" not in summary


def test_mp4_unplayable_codec_still_transcodes(
        tmp_path: Path, clips: dict[str, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips["mpeg4.mp4"].read_bytes()
    video, item, entry, _ = convert_one(tmp_path, "m.mp4", data, capsys)
    assert video["file"].endswith(".mp4")
    assert _shipped(tmp_path, video) != data
    (step,) = entry["steps"]
    assert step["step"] == "transcode"
    assert item["decision"] == "transcode"
