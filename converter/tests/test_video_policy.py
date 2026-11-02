"""Video policy: one rule (docs/plan.md Phase 26, "One video rule",
superseding Phase 25 item 25.6's "MKV copied whatever the codec").

A video some target browser can display ships byte-identical, whatever
its container or file name, at its true container's extension; anything
no target browser displays transcodes to H.264 MP4. One table, keyed by
the probed container (ISO-BMFF major brand, EBML DocType; never the file
name) and video codec, decides. Audio codecs do not matter: the player
plays videos muted, and the 2026-11-02 headless Chrome probe showed the
picture plays next to any audio track. Nothing unplayable ships, so
there is no "no target browser plays it" warning any more.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from kinetic_extract import media_tools
from kinetic_extract.assets import video_decision
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


H264 = ("-c:v", "libx264", "-pix_fmt", "yuv420p")


@pytest.fixture(scope="module")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")
    return {
        "h264.mkv": _encode(d / "h264.mkv", *H264, "-c:a", "aac"),
        "mpeg4.mkv": _encode(d / "mpeg4.mkv", "-c:v", "mpeg4",
                             "-c:a", "aac"),
        "vp9.webm": _encode(d / "vp9.webm", "-c:v", "libvpx-vp9",
                            "-c:a", "libopus"),
        "h264.mp4": _encode(d / "h264.mp4", *H264, "-c:a", "aac"),
        "h264-ac3.mp4": _encode(d / "h264-ac3.mp4", *H264, "-c:a", "ac3"),
        "mpeg4.mp4": _encode(d / "mpeg4.mp4", "-c:v", "mpeg4",
                             "-c:a", "aac"),
        "h264-pcm.mov": _encode(d / "h264-pcm.mov", *H264,
                                "-c:a", "pcm_s16le"),
        "prores.mov": _encode(d / "prores.mov", "-c:v", "prores_ks",
                              "-an"),
        "h264.m4v": _encode(d / "h264.m4v", *H264, "-c:a", "aac"),
        "h264.avi": _encode(d / "h264.avi", *H264, "-an"),
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


def _assert_kept(tmp_path: Path, data: bytes, video: dict, item: dict,
                 entry: dict, summary: str, ext: str, codec: str) -> None:
    assert _shipped(tmp_path, video) == data
    digest = hashlib.sha256(data).hexdigest()
    assert video["file"] == f"media/{digest[:2]}/{digest}.{ext}"
    assert entry["steps"] == [{"step": "preserve", "codec": codec}]
    assert "tools" not in entry
    assert item["decision"] == "copy"
    assert item["sniffedFormat"] == ext
    assert item["codec"] == codec
    assert "warning" not in item
    assert "warning:" not in summary


def _assert_transcoded(tmp_path: Path, data: bytes, video: dict,
                       item: dict, entry: dict, summary: str) -> None:
    assert video["file"].endswith(".mp4")
    shipped = tmp_path / "out" / video["file"]
    assert shipped.read_bytes() != data
    (step,) = entry["steps"]
    assert step["step"] == "transcode"
    assert item["decision"] == "transcode"
    assert "warning" not in item
    assert "warning:" not in summary
    assert "no target browser" not in summary
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-v", "error", "-select_streams",
         "v:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0",
         str(shipped)], capture_output=True, text=True, check=True)
    assert proc.stdout.strip() == "h264"


@pytest.mark.parametrize(("clip", "name", "ext", "codec"), [
    ("h264.mkv", "m.mkv", "mkv", "h264"),
    ("h264.mp4", "m.mp4", "mp4", "h264"),
    ("vp9.webm", "m.webm", "webm", "vp9"),
    ("h264-pcm.mov", "m.mov", "mov", "h264"),
    ("h264.m4v", "m.m4v", "m4v", "h264"),
    # Audio never decides: AC-3 next to H.264 still plays (muted player).
    ("h264-ac3.mp4", "m.mp4", "mp4", "h264"),
    # The container decides, not the name; it ships at its true ext.
    ("h264.mkv", "m.mp4", "mkv", "h264"),
    ("h264.mp4", "m.webm", "mp4", "h264"),
    ("h264-pcm.mov", "m.mp4", "mov", "h264"),
])
def test_playable_video_ships_byte_identical(
        tmp_path: Path, clips: dict[str, Path], clip: str, name: str,
        ext: str, codec: str, capsys: pytest.CaptureFixture[str]) -> None:
    data = clips[clip].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, name, data, capsys)
    _assert_kept(tmp_path, data, video, item, entry, summary, ext, codec)


@pytest.mark.parametrize(("clip", "name"), [
    ("mpeg4.mkv", "m.mkv"),     # was copied with a warning (25.6)
    ("mpeg4.mkv", "m.mp4"),
    ("mpeg4.mp4", "m.mp4"),
    ("prores.mov", "m.mov"),
    ("h264.avi", "m.avi"),      # no target browser opens AVI at all
])
def test_unplayable_video_transcodes_to_h264_mp4(
        tmp_path: Path, clips: dict[str, Path], clip: str, name: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips[clip].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, name, data, capsys)
    _assert_transcoded(tmp_path, data, video, item, entry, summary)


@pytest.mark.parametrize(("container", "codec", "keep"), [
    ("mp4", "h264", True), ("mp4", "hevc", True), ("mp4", "vp9", True),
    ("mp4", "av1", True), ("mp4", "mpeg4", False), ("mp4", "mjpeg", False),
    ("mov", "h264", True), ("mov", "hevc", True), ("mov", "prores", False),
    ("m4v", "h264", True),
    ("webm", "vp8", True), ("webm", "vp9", True), ("webm", "av1", True),
    ("mkv", "h264", True), ("mkv", "hevc", True), ("mkv", "vp8", True),
    ("mkv", "av1", True), ("mkv", "mpeg4", False), ("mkv", "mpeg2video",
                                                    False),
    ("mkv", "theora", False), ("mkv", "ffv1", False),
    ("avi", "h264", False), ("ogg", "theora", False),
    ("mpegts", "h264", False), (None, "h264", False),
])
def test_one_playability_table(container: str | None, codec: str,
                               keep: bool) -> None:
    assert video_decision(container, codec) is keep
