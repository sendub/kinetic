"""kinetic-media's ``audio`` kind (docs/plan.md Phase 47, item 2).

A request of kind ``audio`` ships a file every engine plays, decided by
ffprobe's container and codec, never the file name: MP3, AAC in MP4,
PCM WAV, FLAC, and Vorbis or Opus in WebM keep their bytes; Vorbis or
Opus in Ogg, AAC in ADTS and MP3 in another container are copied into
WebM, M4A or MP3 without re-encoding; anything else becomes Opus in
WebM. A video's sound ships by the same rule after a loudness check
(``silent``, ``no audio``). ``durationSeconds`` is decoded samples over
the sample rate. Ledger steps, the reuse cache, ``--jobs``, decoder
hooks and ``rebuild`` work as they do for video.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import wave
from pathlib import Path

import pytest

import extra_hook
from kinetic_extract import assets, media_tools
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.media import probe_duration_seconds
from kinetic_extract.media_cli import main as media_main
from test_rpa import write_rpa

HERE = Path(__file__).resolve().parent
HOOK = f"{HERE / 'extra_hook.py'}:decode"
LEDGER = "media-ledger.json"

TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:"
        "duration=1"]
PICTURE = ["-f", "lavfi", "-i", "testsrc=size=64x36:rate=10:duration=1"]
H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"]

# Source files (path under the game root -> ffmpeg arguments). Names
# never decide: really-ogg.mp3 holds Ogg Vorbis.
SOURCES = {
    "a/tone.mp3": [*TONE, "-c:a", "libmp3lame", "-b:a", "64k"],
    "a/tone.m4a": [*TONE, "-c:a", "aac", "-b:a", "64k"],
    "a/tone.wav": [*TONE, "-c:a", "pcm_s16le"],
    "a/tone.flac": [*TONE, "-c:a", "flac"],
    "a/vorbis.webm": [*TONE, "-c:a", "libvorbis"],
    "a/opus.webm": [*TONE, "-c:a", "libopus"],
    "a/vorbis.ogg": [*TONE, "-c:a", "libvorbis"],
    "a/opus.opus": [*TONE, "-c:a", "libopus"],
    "a/really-ogg.mp3": [*TONE, "-c:a", "libvorbis", "-f", "ogg"],
    "a/tone.aac": [*TONE, "-c:a", "aac", "-b:a", "64k", "-f", "adts"],
    "a/mp3-in.wav": [*TONE, "-c:a", "libmp3lame", "-b:a", "64k"],
    "a/tone.aiff": [*TONE, "-c:a", "pcm_s16be"],
    "a/surround.aiff": [*TONE, "-ac", "6", "-c:a", "pcm_s16be"],
    "a/cover.mp3": [*TONE, "-f", "lavfi", "-i",
                    "testsrc=size=32x32:rate=1:duration=1", "-map", "0:a",
                    "-map", "1:v", "-frames:v", "1", "-c:a", "libmp3lame",
                    "-b:a", "64k", "-c:v", "png", "-disposition:v",
                    "attached_pic"],
    # VBR, no Xing header: one second of silence, then one of noise, so
    # the first frame's bitrate misstates the length.
    "a/vbr.mp3": ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
                  "-f", "lavfi", "-i", "anoisesrc=r=44100:a=0.5:d=1:seed=7",
                  "-filter_complex",
                  "[0:a]atrim=duration=1[s];[s][1:a]concat=n=2:v=0:a=1",
                  "-c:a", "libmp3lame", "-q:a", "0", "-write_xing", "0",
                  "-id3v2_version", "0"],
    "v/tone.mp4": [*PICTURE, *TONE, *H264, "-c:a", "aac", "-shortest"],
    "v/silent.mp4": [*PICTURE, "-f", "lavfi", "-i",
                     "anullsrc=r=44100:cl=stereo", *H264, "-c:a", "aac",
                     "-shortest"],
    "v/mute.mp4": [*PICTURE, *H264, "-an"],
    "v/mp2.avi": [*PICTURE, *TONE, "-c:v", "mpeg4", "-c:a", "mp2",
                  "-shortest"],
    "v/opus.mkv": [*PICTURE, *TONE, "-c:v", "mpeg4", "-c:a", "libopus",
                   "-shortest"],
}
# The format each source's request must report, then the decision and
# the shipped extension (None: nothing ships).
EXPECTED = {
    "a/tone.mp3": ("mp3", "mp3", "copy", "mp3"),
    "a/tone.m4a": ("mp4", "aac", "copy", "m4a"),
    "a/tone.wav": ("wav", "pcm_s16le", "copy", "wav"),
    "a/tone.flac": ("flac", "flac", "copy", "flac"),
    "a/vorbis.webm": ("webm", "vorbis", "copy", "webm"),
    "a/opus.webm": ("webm", "opus", "copy", "webm"),
    "a/vorbis.ogg": ("ogg", "vorbis", "remux", "webm"),
    "a/opus.opus": ("ogg", "opus", "remux", "webm"),
    "a/really-ogg.mp3": ("ogg", "vorbis", "remux", "webm"),
    "a/tone.aac": ("aac", "aac", "remux", "m4a"),
    "a/mp3-in.wav": ("wav", "mp3", "remux", "mp3"),
    "a/tone.aiff": ("aiff", "pcm_s16be", "transcode", "webm"),
    "a/surround.aiff": ("aiff", "pcm_s16be", "transcode", "webm"),
    "a/cover.mp3": ("mp3", "mp3", "copy", "mp3"),
    "a/vbr.mp3": ("mp3", "mp3", "copy", "mp3"),
    "v/tone.mp4": ("mp4", "aac", "extract", "m4a"),
    "v/silent.mp4": ("mp4", "aac", "silent", None),
    "v/mute.mp4": ("mp4", None, "no audio", None),
    "v/mp2.avi": ("avi", "mp2", "extract", "webm"),
    "v/opus.mkv": ("mkv", "opus", "extract", "webm"),
    "x/empty.wav": ("wav", "pcm_s16le", "skipped", None),
    "x/rooms.rpa!tone.ogg": ("ogg", "vorbis", "remux", "webm"),
}
STEP_OF = {"copy": "preserve", "remux": "remux", "transcode": "transcode",
           "extract": "extract"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _ffmpeg(out: Path, args: list[str]) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([*media_tools.ffmpeg_cmd(), "-y", *args,
                           str(out)], capture_output=True, text=True,
                          check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr


def _empty_wav(path: Path) -> None:
    """A WAV header with no samples: it probes, but never decodes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(44100)
        out.writeframes(b"")


def _make_root(root: Path) -> Path:
    for rel, args in SOURCES.items():
        _ffmpeg(root / rel, args)
    _empty_wav(root / "x" / "empty.wav")
    write_rpa(root / "x" / "rooms.rpa",
              {"tone.ogg": (root / "a" / "vorbis.ogg").read_bytes()})
    return root


def _request(asset: str) -> dict:
    if "!" in asset:
        archive, member = asset.split("!")
        source = {"archive": archive, "member": member}
    else:
        source = {"path": asset}
    return {"source": source, "kind": "audio", "id": asset}


REQUESTS = [_request(asset) for asset in EXPECTED]


def ship(root: Path, out: Path, requests: list[dict], *extra: str) -> int:
    listing = out.parent / f"{out.name}-{_sha(repr(requests).encode())[:8]}" \
        ".json"
    listing.write_text(json.dumps(requests), encoding="utf-8")
    return media_main(["ship", str(root), str(out), "--list", str(listing),
                       *extra])


def ledger_of(out: Path) -> dict:
    return json.loads((out / LEDGER).read_text("utf-8"))


def results_of(out: Path) -> dict[str, dict]:
    return {e["request"]["id"]: e["result"]
            for e in ledger_of(out)["requests"]}


def tree(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def pcm(path: Path) -> str:
    """sha256 of the first audio stream decoded to 32-bit float samples
    at its own rate and channel count."""
    proc = subprocess.run([*media_tools.ffmpeg_cmd(), "-i", str(path),
                           "-map", "0:a:0", "-c:a", "pcm_f32le", "-f",
                           "f32le", "-"], capture_output=True, check=False)
    assert proc.returncode == 0 and proc.stdout, proc.stderr
    return _sha(proc.stdout)


def stream(path: Path) -> dict:
    """ffprobe's container name and first audio stream."""
    proc = subprocess.run([*media_tools.ffprobe_cmd(), "-show_entries",
                           "format=format_name:stream=codec_type,codec_name,"
                           "sample_rate,channels", "-of", "json", str(path)],
                          capture_output=True, text=True, check=False)
    info = json.loads(proc.stdout)
    audio = [s for s in info["streams"] if s["codec_type"] == "audio"]
    return {"format": info["format"]["format_name"], **audio[0]}


def decoded_seconds(path: Path) -> float:
    """Samples ffmpeg decodes from the first audio stream over its rate:
    counted from 16-bit mono PCM, the rate read by ffprobe."""
    proc = subprocess.run([*media_tools.ffmpeg_cmd(), "-i", str(path),
                           "-map", "0:a:0", "-ac", "1", "-c:a", "pcm_s16le",
                           "-f", "s16le", "-"], capture_output=True,
                          check=False)
    assert proc.returncode == 0, proc.stderr
    return round(len(proc.stdout) / 2 / int(stream(path)["sample_rate"]), 6)


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "x-cache"))


@pytest.fixture(scope="module")
def shipped(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """(game root, ship output) of every request, made once, cold."""
    base = tmp_path_factory.mktemp("audio")
    root = _make_root(base / "root")
    out = base / "out"
    rpa_mod.reset_cache()
    assert ship(root, out, REQUESTS) == 0
    return root, out


@pytest.fixture
def copies(shipped: tuple[Path, Path], tmp_path: Path) -> tuple[Path, Path]:
    root, out = shipped
    shutil.copytree(root, tmp_path / "root")
    shutil.copytree(out, tmp_path / "out")
    return tmp_path / "root", tmp_path / "out"


# --- the rule ---------------------------------------------------------------

@pytest.mark.parametrize("asset", list(EXPECTED))
def test_decision_by_container_and_codec(shipped: tuple[Path, Path],
                                         asset: str) -> None:
    root, out = shipped
    container, codec, decision, ext = EXPECTED[asset]
    result = results_of(out)[asset]
    assert result["decision"] == decision, result["notes"]
    assert result["sniffedFormat"] == container
    assert result.get("codec") == codec
    if ext is None:
        assert "file" not in result and "durationSeconds" not in result
        return
    assert result["file"].endswith(f".{ext}")
    entry = ledger_of(out)["media"][result["file"]]
    assert entry["kind"] == "audio"
    assert [s["step"] for s in entry["steps"]] == [STEP_OF[decision]]
    assert "width" not in result and "height" not in result


@pytest.mark.parametrize("asset", [a for a, e in EXPECTED.items()
                                   if e[2] == "copy"])
def test_kept_formats_ship_byte_identical(shipped: tuple[Path, Path],
                                          asset: str) -> None:
    root, out = shipped
    result = results_of(out)[asset]
    source = (root / asset).read_bytes()
    assert (out / result["file"]).read_bytes() == source
    entry = ledger_of(out)["media"][result["file"]]
    assert entry["steps"] == [{"step": "preserve",
                               "codec": EXPECTED[asset][1]}]
    assert "tools" not in entry


@pytest.mark.parametrize("asset", ["a/vorbis.ogg", "a/opus.opus",
                                   "a/really-ogg.mp3", "a/tone.aac",
                                   "a/mp3-in.wav"])
def test_remux_copies_the_stream_unchanged(shipped: tuple[Path, Path],
                                           asset: str) -> None:
    root, out = shipped
    shipped_file = out / results_of(out)[asset]["file"]
    assert stream(shipped_file)["codec_name"] == EXPECTED[asset][1]
    assert pcm(shipped_file) == pcm(root / asset)
    (step,) = ledger_of(out)["media"][results_of(out)[asset]["file"]][
        "steps"]
    args = step["args"]
    assert args[args.index("-c:a") + 1] == "copy"
    assert args[args.index("-map") + 1] == "0:a:0"
    assert step["reason"]


def test_ogg_ships_as_webm(shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    for asset in ("a/vorbis.ogg", "a/opus.opus"):
        made = stream(out / results_of(out)[asset]["file"])
        assert "webm" in made["format"]


def test_aiff_ships_as_opus_webm(shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    result = results_of(out)["a/tone.aiff"]
    made = stream(out / result["file"])
    assert made["codec_name"] == "opus" and "webm" in made["format"]
    (step,) = ledger_of(out)["media"][result["file"]]["steps"]
    args = step["args"]
    assert args[args.index("-c:a") + 1] == "libopus"
    assert args[args.index("-b:a") + 1] == "128k"
    assert args[args.index("-f") + 1] == "webm"
    assert made["channels"] == 1 and "-ac" not in args


def test_more_than_two_channels_are_downmixed_to_stereo(
        shipped: tuple[Path, Path]) -> None:
    root, out = shipped
    assert stream(root / "a" / "surround.aiff")["channels"] == 6
    result = results_of(out)["a/surround.aiff"]
    made = stream(out / result["file"])
    assert made["codec_name"] == "opus" and made["channels"] == 2
    (step,) = ledger_of(out)["media"][result["file"]]["steps"]
    args = step["args"]
    assert args[args.index("-ac") + 1] == "2"


def test_cover_art_is_audio_not_a_video(shipped: tuple[Path, Path]) -> None:
    root, out = shipped
    result = results_of(out)["a/cover.mp3"]
    assert result["decision"] == "copy"
    assert (out / result["file"]).read_bytes() == \
        (root / "a" / "cover.mp3").read_bytes()


def test_steps_are_single_threaded_and_bitexact(
        shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    seen = 0
    for entry in ledger_of(out)["media"].values():
        (step,) = entry["steps"]
        if step["step"] == "preserve":
            continue
        seen += 1
        args = step["args"]
        at = args.index("-i")
        assert args[at - 2:at] == ["-threads", "1"]
        joined = " ".join(args)
        for flags in ("-filter_threads 1", "-fflags +bitexact",
                      "-flags:a +bitexact", "-map_metadata -1"):
            assert flags in joined
        assert args[-1] == "{output}" and args[at + 1] == "{input}"
        assert entry["tools"] == {"ffmpeg": ledger_of(out)["mediaTools"][
            "ffmpeg"]["version"]}
    assert seen == 9


# --- audio from a video ---------------------------------------------------

@pytest.mark.parametrize(("asset", "codec"), [("v/tone.mp4", "aac"),
                                              ("v/opus.mkv", "opus")])
def test_video_sound_ships_the_tone(shipped: tuple[Path, Path], asset: str,
                                    codec: str) -> None:
    root, out = shipped
    result = results_of(out)[asset]
    made = out / result["file"]
    assert stream(made)["codec_name"] == codec
    assert pcm(made) == pcm(root / asset)
    (step,) = ledger_of(out)["media"][result["file"]]["steps"]
    assert step["step"] == "extract"
    assert step["args"][step["args"].index("-c:a") + 1] == "copy"


def test_video_sound_in_another_codec_is_reencoded(
        shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    result = results_of(out)["v/mp2.avi"]
    assert stream(out / result["file"])["codec_name"] == "opus"
    (step,) = ledger_of(out)["media"][result["file"]]["steps"]
    assert step["step"] == "extract"
    assert step["args"][step["args"].index("-c:a") + 1] == "libopus"


def test_silent_and_missing_sound_are_results_not_errors(
        shipped: tuple[Path, Path], tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    root, _ = shipped
    out = tmp_path / "out"
    requests = [_request("v/silent.mp4"), _request("v/mute.mp4"),
                _request("v/tone.mp4")]
    assert ship(root, out, requests) == 0
    results = results_of(out)
    silent = results["v/silent.mp4"]
    assert silent["decision"] == "silent"
    assert "dB" in " ".join(silent["notes"])
    assert results["v/mute.mp4"]["decision"] == "no audio"
    printed = capsys.readouterr().out
    assert "requests: 3; shipped: 1; skipped: 0; no sound: 2" in printed
    # Only the tone shipped.
    assert len(ledger_of(out)["media"]) == 1


# --- durations ----------------------------------------------------------------

def test_duration_is_decoded_samples_over_rate(
        shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    for asset, result in results_of(out).items():
        if "file" not in result:
            continue
        seconds = decoded_seconds(out / result["file"])
        assert result["durationSeconds"] == seconds, asset
        assert 0.9 < seconds < 2.2, asset


def test_vbr_mp3_without_xing_gets_its_decoded_duration(
        shipped: tuple[Path, Path]) -> None:
    root, out = shipped
    source = root / "a" / "vbr.mp3"
    estimate = probe_duration_seconds(source)
    result = results_of(out)["a/vbr.mp3"]
    assert estimate is not None and abs(estimate - 2.0) > 0.5
    assert abs(result["durationSeconds"] - 2.0) < 0.1


def test_undecodable_audio_fails_its_request(
        shipped: tuple[Path, Path]) -> None:
    _, out = shipped
    result = results_of(out)["x/empty.wav"]
    assert result["decision"] == "skipped"
    assert "decode" in " ".join(result["notes"])
    assert not any(e["source"].get("path") == "x/empty.wav"
                   for e in ledger_of(out)["media"].values())


# --- requests -------------------------------------------------------------------

@pytest.mark.parametrize(("entry", "message"), [
    ({"source": {"path": "a.mp3"}, "kind": "sound"},
     'kind must be "image", "video" or "audio"'),
    ({"source": {"path": "a.mp3"}, "kind": "audio", "startSeconds": 1},
     "startSeconds is for videos only"),
])
def test_bad_audio_requests_are_named(tmp_path: Path, entry: dict,
                                      message: str,
                                      capsys: pytest.CaptureFixture[str],
                                      ) -> None:
    root = tmp_path / "root"
    root.mkdir()
    assert ship(root, tmp_path / "out", [entry]) == 2
    assert message in capsys.readouterr().err


def test_identical_sources_share_one_entry(copies: tuple[Path, Path],
                                           tmp_path: Path) -> None:
    root, _ = copies
    shutil.copyfile(root / "a" / "vorbis.ogg", root / "a" / "again.ogg")
    out = tmp_path / "shared"
    assert ship(root, out, [_request("a/vorbis.ogg"),
                            _request("a/again.ogg")]) == 0
    results = results_of(out)
    assert results["a/vorbis.ogg"]["file"] == results["a/again.ogg"]["file"]
    (entry,) = ledger_of(out)["media"].values()
    assert [m["source"]["path"] for m in entry["alsoFrom"]] == [
        "a/again.ogg"]
    assert entry["alsoFrom"][0]["steps"] == entry["steps"]


def test_decoder_hook_runs_before_the_probe(copies: tuple[Path, Path],
                                            tmp_path: Path,
                                            capsys) -> None:
    root, _ = copies
    plain = (root / "a" / "vorbis.ogg").read_bytes()
    (root / "a" / "wrapped.ogg").write_bytes(extra_hook.wrap(plain))
    out = tmp_path / "hooked"
    assert ship(root, out, [_request("a/wrapped.ogg")], "--decoder",
                HOOK) == 0
    result = results_of(out)["a/wrapped.ogg"]
    assert result["decision"] == "remux"
    steps = ledger_of(out)["media"][result["file"]]["steps"]
    assert [s["step"] for s in steps] == ["decode", "remux"]
    assert steps[0]["outputSha256"] == _sha(plain)
    capsys.readouterr()
    assert media_main(["rebuild", str(root), str(out), "--decoder",
                       HOOK]) == 0
    assert "1 matched, 0 failed" in capsys.readouterr().out


# --- cache, re-ship and workers -------------------------------------------------

# What makes or measures an audio output: the file step runner, ffmpeg
# itself, and the duration and loudness decodes.
WORK = [(assets, "run_file_step"), (assets, "ffmpeg_error"),
        (assets, "decoded_duration"), (assets, "max_volume")]


def _spy(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    for module, name in WORK:
        original = getattr(module, name)

        def wrapper(*args, _o=original, _n=name, **kwargs):
            calls.append(_n)
            return _o(*args, **kwargs)
        monkeypatch.setattr(module, name, wrapper)
    return calls


def test_second_ship_is_identical_and_encodes_nothing(
        shipped: tuple[Path, Path], tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    root, _ = shipped
    # A failed decode is not remembered, so the empty WAV would decode
    # again: leave it out.
    requests = [r for r in REQUESTS if r["id"] != "x/empty.wav"]
    calls = _spy(monkeypatch)
    first = tmp_path / "first"
    assert ship(root, first, requests, "--jobs", "1") == 0
    assert {"run_file_step", "decoded_duration", "max_volume"} <= set(calls)
    calls.clear()
    second = tmp_path / "second"
    assert ship(root, second, requests, "--jobs", "1") == 0
    assert calls == []
    assert tree(second) == tree(first)


def test_reship_into_the_folder_changes_nothing(
        copies: tuple[Path, Path]) -> None:
    root, out = copies
    before = tree(out)
    assert ship(root, out, REQUESTS) == 0
    assert tree(out) == before


def test_jobs_give_the_same_folder(shipped: tuple[Path, Path],
                                   tmp_path: Path,
                                   monkeypatch: pytest.MonkeyPatch) -> None:
    root, out = shipped
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    serial = tmp_path / "serial"
    parallel = tmp_path / "parallel"
    assert ship(root, serial, REQUESTS, "--jobs", "1") == 0
    assert ship(root, parallel, REQUESTS, "--jobs", "4",
                "--video-jobs", "2") == 0
    assert tree(parallel) == tree(serial)
    assert tree(serial)[LEDGER] == tree(out)[LEDGER]


# --- rebuild --------------------------------------------------------------------

def test_rebuild_reproduces_every_audio_file(
        shipped: tuple[Path, Path], tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    root, out = shipped
    media = ledger_of(out)["media"]
    capsys.readouterr()
    assert media_main(["rebuild", str(root), str(out)]) == 0
    assert f"{len(media)} matched, 0 failed" in capsys.readouterr().out
    bare = tmp_path / "bare"
    bare.mkdir()
    shutil.copyfile(out / LEDGER, bare / LEDGER)
    made = tmp_path / "made"
    assert media_main(["rebuild", str(root), str(bare), "--out",
                       str(made), "--jobs", "4"]) == 0
    assert tree(made) == {k: v for k, v in tree(out).items()
                          if k.startswith("media/")}


def test_rebuild_fails_on_a_changed_shipped_byte(
        copies: tuple[Path, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    root, out = copies
    ref = results_of(out)["a/tone.aiff"]["file"]
    data = bytearray((out / ref).read_bytes())
    data[-1] ^= 0xFF
    (out / ref).write_bytes(bytes(data))
    assert media_main(["rebuild", str(root), str(out)]) == 1
    assert f"{ref}: folder file differs from the ledger" in \
        capsys.readouterr().out


def test_rebuild_fails_on_a_changed_source_byte(
        copies: tuple[Path, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    root, out = copies
    ref = results_of(out)["v/tone.mp4"]["file"]
    path = root / "v" / "tone.mp4"
    data = bytearray(path.read_bytes())
    data[len(data) // 2] ^= 0xFF
    path.write_bytes(bytes(data))
    assert media_main(["rebuild", str(root), str(out)]) == 1
    assert f"{ref}: source hash mismatch for v/tone.mp4" in \
        capsys.readouterr().out


def test_rebuild_fails_on_a_changed_recipe(
        copies: tuple[Path, Path],
        capsys: pytest.CaptureFixture[str]) -> None:
    root, out = copies
    ledger = ledger_of(out)
    ref = results_of(out)["a/tone.aiff"]["file"]
    (step,) = ledger["media"][ref]["steps"]
    step["args"][step["args"].index("-b:a") + 1] = "64k"
    (out / LEDGER).write_text(json.dumps(ledger), "utf-8")
    assert media_main(["rebuild", str(root), str(out)]) == 1
    assert f"{ref}: output mismatch" in capsys.readouterr().out
