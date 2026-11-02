"""Video policy: measured playability (docs/plan.md Phase 26, "Video
playability measured, not assumed", superseding the earlier "one video
rule").

Measured 2026-11-02 in Safari 26.6.2 (M2) and headless Chrome 156 and
agreed by the user. Video track only: the player plays videos muted, so
audio never decides.

- KEEP byte-identical when both browsers play it: H.264 in
  MP4/MOV/M4V/3GP; HEVC tagged hvc1 in MP4/MOV/M4V; VP9 in MP4/WebM/MKV;
  VP8 in WebM/MKV. The file ships at its true container's extension.
- REMUX (stream copy, no re-encode) into MP4 when only the container or
  the HEVC tag fails: H.264/HEVC (and VP9) in MKV/AVI/MPEG-TS/...; HEVC
  tagged hev1 becomes hvc1. Only the video stream is kept.
- RE-ENCODE to H.264 MP4 when the codec fails in either browser: AV1,
  MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263, Theora, FFV1, VP8 outside
  WebM/MKV, anything unknown.

The container comes from the bytes (ISO-BMFF major brand incl. 3GP
brands, EBML DocType, ffprobe format), never the file name.
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


def _encode(out: Path, *args: str, size: str = "64x36",
            audio: bool = True) -> Path:
    cmd = [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
           "-i", f"testsrc=size={size}:rate=10:duration=1"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1"]
    cmd += [*args, *([] if audio else ["-an"]), "-shortest", str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


H264 = ("-c:v", "libx264", "-pix_fmt", "yuv420p")
HEVC = ("-c:v", "libx265", "-pix_fmt", "yuv420p",
        "-x265-params", "log-level=error")
AAC = ("-c:a", "aac")
QCIF = "176x144"  # H.263 takes only its fixed picture sizes
AV1_SIZE = "64x64"  # SVT-AV1 refuses pictures under 64 lines


@pytest.fixture(scope="module")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("clips")
    specs: dict[str, tuple[tuple[str, ...], dict]] = {
        # keep
        "h264.mp4": ((*H264, *AAC), {}),
        "h264-ac3.mp4": ((*H264, "-c:a", "ac3"), {}),
        "h264-pcm.mov": ((*H264, "-c:a", "pcm_s16le"), {}),
        "h264.m4v": ((*H264, *AAC, "-f", "mp4", "-brand", "M4V "), {}),
        "h264.3gp": ((*H264, *AAC), {}),
        "hvc1.mov": ((*HEVC, "-tag:v", "hvc1", *AAC), {}),
        "hvc1.mp4": ((*HEVC, "-tag:v", "hvc1", *AAC), {}),
        "vp9.mp4": (("-c:v", "libvpx-vp9", "-c:a", "libopus"), {}),
        "vp9.webm": (("-c:v", "libvpx-vp9", "-c:a", "libopus"), {}),
        "vp8.webm": (("-c:v", "libvpx", "-c:a", "libvorbis"), {}),
        "vp9.mkv": (("-c:v", "libvpx-vp9", "-c:a", "libopus"), {}),
        "vp8.mkv": (("-c:v", "libvpx", "-c:a", "libvorbis"), {}),
        # remux
        "h264.mkv": ((*H264, *AAC), {}),
        "h264-noaudio.mkv": (H264, {"audio": False}),
        "hevc.mkv": ((*HEVC, *AAC), {}),
        "h264.ts": ((*H264, *AAC), {}),
        "h264.avi": ((*H264, "-c:a", "libmp3lame"), {}),
        "hev1.mp4": ((*HEVC, "-tag:v", "hev1", *AAC), {}),
        "hev1.mov": ((*HEVC, "-tag:v", "hev1", *AAC), {}),
        # re-encode
        "av1.mp4": (("-c:v", "libsvtav1", "-pix_fmt", "yuv420p",
                     "-preset", "12", *AAC), {"size": AV1_SIZE}),
        "av1.webm": (("-c:v", "libsvtav1", "-pix_fmt", "yuv420p",
                      "-preset", "12", "-c:a", "libopus"),
                     {"size": AV1_SIZE}),
        "mpeg4.mkv": (("-c:v", "mpeg4", *AAC), {}),
        "mpeg4.mp4": (("-c:v", "mpeg4", *AAC), {}),
        "prores.mov": (("-c:v", "prores_ks",), {"audio": False}),
        "theora.ogv": (("-c:v", "libtheora", "-c:a", "libvorbis"), {}),
        "vp8.ogv": (("-c:v", "libvpx", "-c:a", "libvorbis"), {}),
        "mpeg2.mp4": (("-c:v", "mpeg2video", *AAC), {}),
        "h263.3gp": (("-c:v", "h263", *AAC), {"size": QCIF}),
    }
    return {name: _encode(d / name, *args, **kw)
            for name, (args, kw) in specs.items()}


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


def _shipped(tmp_path: Path, video: dict) -> Path:
    return tmp_path / "out" / video["file"]


def _streams(path: Path) -> list[dict]:
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-show_entries",
         "stream=codec_type,codec_name,codec_tag_string", "-of", "json",
         str(path)], capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)["streams"]


def _frame_hashes(path: Path) -> list[str]:
    """MD5 of every decoded video frame: equal lists mean the picture was
    not re-encoded."""
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-i", str(path), "-map", "0:v:0",
         "-f", "framemd5", "-"], capture_output=True, text=True,
        check=True)
    return [ln.rsplit(",", 1)[1].strip() for ln in proc.stdout.splitlines()
            if ln and not ln.startswith("#")]


def _packet_hashes(path: Path) -> list[str]:
    """SHA-256 of every video packet's data: equal lists mean the stream
    was copied, not re-encoded."""
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-select_streams", "v:0",
         "-show_packets", "-show_data_hash", "sha256",
         "-show_entries", "packet=data_hash", "-of", "csv=p=0",
         str(path)], capture_output=True, text=True, check=True)
    return [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]


@pytest.mark.parametrize(("clip", "name", "ext", "codec"), [
    ("h264.mp4", "m.mp4", "mp4", "h264"),
    ("h264.m4v", "m.m4v", "m4v", "h264"),
    ("h264-pcm.mov", "m.mov", "mov", "h264"),
    ("h264.3gp", "m.3gp", "3gp", "h264"),
    ("hvc1.mov", "m.mov", "mov", "hevc"),
    ("hvc1.mp4", "m.mp4", "mp4", "hevc"),
    ("vp9.mp4", "m.mp4", "mp4", "vp9"),
    ("vp9.webm", "m.webm", "webm", "vp9"),
    ("vp8.webm", "m.webm", "webm", "vp8"),
    ("vp9.mkv", "m.mkv", "mkv", "vp9"),
    ("vp8.mkv", "m.mkv", "mkv", "vp8"),
    # Audio never decides: AC-3 next to H.264 still plays (muted player).
    ("h264-ac3.mp4", "m.mp4", "mp4", "h264"),
    # The container decides, not the name; it ships at its true ext.
    ("h264.mp4", "m.webm", "mp4", "h264"),
    ("h264-pcm.mov", "m.mp4", "mov", "h264"),
    ("h264.3gp", "m.mp4", "3gp", "h264"),
    ("vp9.mkv", "m.webm", "mkv", "vp9"),
])
def test_video_both_browsers_play_ships_byte_identical(
        tmp_path: Path, clips: dict[str, Path], clip: str, name: str,
        ext: str, codec: str, capsys: pytest.CaptureFixture[str]) -> None:
    data = clips[clip].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, name, data, capsys)
    assert _shipped(tmp_path, video).read_bytes() == data
    digest = hashlib.sha256(data).hexdigest()
    assert video["file"] == f"media/{digest[:2]}/{digest}.{ext}"
    assert entry["steps"] == [{"step": "preserve", "codec": codec}]
    assert "tools" not in entry
    assert item["decision"] == "copy"
    assert item["sniffedFormat"] == ext
    assert item["codec"] == codec
    assert "warning" not in item
    assert "warning:" not in summary


@pytest.mark.parametrize(("clip", "name", "codec", "packets_equal"), [
    ("h264.mkv", "m.mkv", "h264", True),
    ("h264-noaudio.mkv", "m.mkv", "h264", True),
    ("h264.mkv", "m.mp4", "h264", True),   # the name lies: still MKV
    ("hevc.mkv", "m.mkv", "hevc", True),
    ("hev1.mp4", "m.mp4", "hevc", True),
    ("hev1.mov", "m.mov", "hevc", True),
    # MPEG-TS/AVI carry H.264 as Annex B start codes, MP4 as length
    # prefixes: the packet bytes differ, the decoded pictures do not.
    ("h264.ts", "m.ts", "h264", False),
    ("h264.avi", "m.avi", "h264", False),
])
def test_video_only_container_fails_remuxes_to_mp4(
        tmp_path: Path, clips: dict[str, Path], clip: str, name: str,
        codec: str, packets_equal: bool,
        capsys: pytest.CaptureFixture[str]) -> None:
    source = clips[clip]
    video, item, entry, summary = convert_one(
        tmp_path, name, source.read_bytes(), capsys)
    shipped = _shipped(tmp_path, video)
    assert video["file"].endswith(".mp4")
    assert item["decision"] == "remux"
    assert "warning" not in item
    assert "warning:" not in summary
    (step,) = entry["steps"]
    assert step["step"] == "remux"
    assert step["reason"]
    args = step["args"]
    assert args[args.index("-i") + 1] == "{input}"
    assert args[-1] == "{output}"
    assert "copy" in args and "libx264" not in args
    assert "+bitexact" in args and "+faststart" in args
    assert not any("/" in a for a in args)
    assert entry["tools"] == {"ffmpeg": entry["tools"]["ffmpeg"]}
    # Only the video stream survives (the player plays video muted).
    (stream,) = _streams(shipped)
    assert stream["codec_type"] == "video"
    assert stream["codec_name"] == codec
    if codec == "hevc":
        assert stream["codec_tag_string"] == "hvc1"
        assert "hvc1" in args
    assert _frame_hashes(shipped) == _frame_hashes(source)
    if packets_equal:
        assert _packet_hashes(shipped) == _packet_hashes(source)


@pytest.mark.parametrize(("clip", "name"), [
    ("av1.mp4", "m.mp4"),       # Safari on M2 decodes no AV1
    ("av1.webm", "m.webm"),
    ("mpeg4.mkv", "m.mkv"),
    ("mpeg4.mkv", "m.mp4"),
    ("mpeg4.mp4", "m.mp4"),
    ("prores.mov", "m.mov"),
    ("theora.ogv", "m.ogv"),
    ("vp8.ogv", "m.ogv"),       # VP8 plays in WebM/MKV only
    ("mpeg2.mp4", "m.mp4"),
    ("h263.3gp", "m.3gp"),
])
def test_video_codec_fails_transcodes_to_h264_mp4(
        tmp_path: Path, clips: dict[str, Path], clip: str, name: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    data = clips[clip].read_bytes()
    video, item, entry, summary = convert_one(tmp_path, name, data, capsys)
    shipped = _shipped(tmp_path, video)
    assert video["file"].endswith(".mp4")
    assert shipped.read_bytes() != data
    (step,) = entry["steps"]
    assert step["step"] == "transcode"
    assert item["decision"] == "transcode"
    assert "warning" not in item
    assert "warning:" not in summary
    video_streams = [s for s in _streams(shipped)
                     if s["codec_type"] == "video"]
    assert [s["codec_name"] for s in video_streams] == ["h264"]


@pytest.mark.parametrize(("container", "codec", "tag", "decision"), [
    ("mp4", "h264", "avc1", "keep"), ("mov", "h264", "avc1", "keep"),
    ("m4v", "h264", "avc1", "keep"), ("3gp", "h264", "avc1", "keep"),
    ("mp4", "hevc", "hvc1", "keep"), ("mov", "hevc", "hvc1", "keep"),
    ("m4v", "hevc", "hvc1", "keep"),
    ("mp4", "vp9", "vp09", "keep"), ("webm", "vp9", "", "keep"),
    ("mkv", "vp9", "", "keep"), ("webm", "vp8", "", "keep"),
    ("mkv", "vp8", "", "keep"),
    ("mp4", "hevc", "hev1", "remux"), ("mov", "hevc", "hev1", "remux"),
    ("mkv", "h264", "", "remux"), ("mkv", "hevc", "", "remux"),
    ("avi", "h264", "H264", "remux"), ("mpegts", "h264", "", "remux"),
    ("mpegts", "hevc", "", "remux"), ("mpeg", "h264", "", "remux"),
    ("3gp", "hevc", "hvc1", "remux"), ("mov", "vp9", "vp09", "remux"),
    ("mp4", "av1", "av01", "transcode"), ("webm", "av1", "", "transcode"),
    ("mkv", "av1", "", "transcode"), ("mp4", "mpeg4", "mp4v", "transcode"),
    ("mkv", "mpeg4", "", "transcode"),
    ("mp4", "mpeg2video", "mp4v", "transcode"),
    ("mp4", "mjpeg", "mp4v", "transcode"),
    ("mov", "prores", "apcn", "transcode"),
    ("3gp", "h263", "s263", "transcode"), ("ogg", "theora", "",
                                           "transcode"),
    ("ogg", "vp8", "", "transcode"), ("mp4", "vp8", "", "transcode"),
    ("mkv", "ffv1", "", "transcode"), ("mkv", "theora", "", "transcode"),
    ("mp4", None, None, "transcode"), (None, "h264", None, "remux"),
])
def test_measured_playability_table(container: str | None,
                                    codec: str | None, tag: str | None,
                                    decision: str) -> None:
    assert video_decision(container, codec, tag) == decision
