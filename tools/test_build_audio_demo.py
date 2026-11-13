"""Tests for fixtures/build_audio_demo.py. Run with:

    .venv/bin/pytest tools/test_build_audio_demo.py -q

fixtures/audio-demo is gitignored, so these tests always build from
scratch into temporary folders.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
import wave
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD_AUDIO_DEMO = REPO_ROOT / "fixtures" / "build_audio_demo.py"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import validate_content  # noqa: E402

# The player's default text hold (docs/content-format.md, Timing).
MIN_HOLD_SECONDS = 1.5
SECONDS_PER_CHAR = 0.06


def build(out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILD_AUDIO_DEMO), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True)


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("first") / "audio-demo"
    proc = build(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


@pytest.fixture(scope="module")
def manifest(built: Path) -> dict:
    return json.loads((built / "manifest.json").read_text(encoding="utf-8"))


def tracks_of(manifest: dict) -> dict[str, dict]:
    return manifest["audio"]["tracks"]


def item_audio(manifest: dict) -> list[dict]:
    return [item["audio"] for item in manifest["items"] if "audio" in item]


def sfx_lists(manifest: dict) -> list[list[dict]]:
    return [audio["sfx"] for audio in item_audio(manifest) if "sfx" in audio]


def music_ids(manifest: dict) -> set[str]:
    return {audio["music"] for audio in item_audio(manifest)
            if isinstance(audio.get("music"), str)}


def ambience_shrinks(manifest: dict) -> bool:
    """Some item sets a smaller, non-empty ambience set than the one set
    before it in array order: one loop stops, another plays on."""
    previous: list[str] = []
    for audio in item_audio(manifest):
        if "ambience" not in audio:
            continue
        now = audio["ambience"]
        if now and set(now) < set(previous):
            return True
        previous = now
    return False


def decoded_seconds(path: Path, scratch: Path) -> float:
    """Samples over rate, read back with the wave module from ffmpeg's
    decode to a WAV file: a second way to the length the builder records."""
    wav = scratch / f"{path.name}.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i",
         str(path), "-map", "0:a:0", "-c:a", "pcm_s16le", str(wav)],
        check=True)
    with wave.open(str(wav)) as decoded:
        return decoded.getnframes() / decoded.getframerate()


def codec_of(path: Path) -> str:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True)
    return probe.stdout.strip()


def test_fresh_build_validates_with_no_audio_warnings(built: Path,
                                                      manifest: dict) -> None:
    assert validate_content.validate_folder(built) == []
    assert validate_content.audio_warnings(manifest, built) == []


def test_an_audio_warning_fails_the_build(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.syspath_prepend(str(BUILD_AUDIO_DEMO.parent))
    import build_audio_demo

    spare = ("spare", "wav", build_audio_demo.tone("0", 0.1), None, {})
    monkeypatch.setattr(build_audio_demo, "TRACKS",
                        [*build_audio_demo.TRACKS, spare])
    monkeypatch.setattr(sys, "argv",
                        ["build_audio_demo.py", "--out",
                         str(tmp_path / "audio-demo")])
    with pytest.raises(SystemExit) as exited:
        build_audio_demo.main()
    assert exited.value.code == 1
    assert "audio.tracks.spare: no item uses this track" in \
        capsys.readouterr().err


def test_two_builds_are_byte_identical(built: Path, tmp_path: Path) -> None:
    again = tmp_path / "audio-demo"
    proc = build(again)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    first = {p.name: p.read_bytes() for p in built.iterdir()}
    second = {p.name: p.read_bytes() for p in again.iterdir()}
    assert sorted(first) == sorted(second)
    assert [name for name in first if first[name] != second[name]] == []


FIELD_USES = {
    "track file": lambda m: all("file" in t for t in tracks_of(m).values()),
    "track durationSeconds": lambda m: all(
        t["durationSeconds"] > 0 for t in tracks_of(m).values()),
    "track startSeconds": lambda m: any(
        t.get("startSeconds", 0) > 0 for t in tracks_of(m).values()),
    "track loopStartSeconds other than its start": lambda m: any(
        "loopStartSeconds" in t
        and t["loopStartSeconds"] != t.get("startSeconds", 0)
        for t in tracks_of(m).values()),
    "loop false on a music track": lambda m: any(
        tracks_of(m)[track_id].get("loop") is False
        for track_id in music_ids(m)),
    "track volume below 1": lambda m: any(
        t.get("volume", 1) < 1 for t in tracks_of(m).values()),
    "music set to a track": lambda m: bool(music_ids(m)),
    "music null": lambda m: any(
        "music" in a and a["music"] is None for a in item_audio(m)),
    "two ambience loops at once": lambda m: any(
        len(a.get("ambience", [])) >= 2 for a in item_audio(m)),
    "ambience set shrinks": ambience_shrinks,
    "ambience []": lambda m: any(
        a.get("ambience") == [] for a in item_audio(m)),
    "fadeMs other than the default": lambda m: any(
        "fadeMs" in a and a["fadeMs"] != 1000 for a in item_audio(m)),
    "sfx delayMs": lambda m: any(
        shot.get("delayMs", 0) > 0 for s in sfx_lists(m) for shot in s),
    "two sfx on one channel": lambda m: any(
        len([shot for shot in s if "channel" in shot]) >= 2
        and len({shot["channel"] for shot in s if "channel" in shot}) == 1
        for s in sfx_lists(m)),
    "two sfx without a channel": lambda m: any(
        len(s) >= 2 and not any("channel" in shot for shot in s)
        for s in sfx_lists(m)),
    "voice": lambda m: any("voice" in a for a in item_audio(m)),
    "videoSound with duck below 1": lambda m: any(
        a.get("videoSound", {}).get("duck", 1) < 1 for a in item_audio(m)),
    "an item that sets music and ambience": lambda m: any(
        "music" in a and "ambience" in a for a in item_audio(m)),
}


@pytest.mark.parametrize("use", sorted(FIELD_USES))
def test_manifest_uses_every_audio_field(manifest: dict, use: str) -> None:
    assert FIELD_USES[use](manifest), use


def test_tracks_mix_every_accepted_container(built: Path,
                                             manifest: dict) -> None:
    kinds = {(Path(t["file"]).suffix, codec_of(built / t["file"]))
             for t in tracks_of(manifest).values()}
    assert {(".webm", "opus"), (".webm", "vorbis"), (".m4a", "aac"),
            (".mp3", "mp3"), (".wav", "pcm_s16le"),
            (".flac", "flac")} <= kinds


def looping_tracks(manifest: dict) -> set[str]:
    """Tracks the demo plays as loops: music or ambience that does not
    set `loop: false`, and a video's sound."""
    tracks = tracks_of(manifest)
    ids = {audio["videoSound"]["track"] for audio in item_audio(manifest)
           if "videoSound" in audio}
    for audio in item_audio(manifest):
        named = [audio.get("music"), *audio.get("ambience", [])]
        ids |= {t for t in named
                if isinstance(t, str) and tracks[t].get("loop", True)}
    return ids


def test_looping_tracks_are_in_loop_safe_formats(built: Path,
                                                 manifest: dict) -> None:
    """MP3, Opus in WebM and Vorbis in Ogg shift a decoded loop's start
    (docs/content-format.md, Audio); every loop avoids them."""
    loops = looping_tracks(manifest)
    assert {"calm", "bright", "steps", "rain", "hum", "warm", "cold",
            "clock"} == loops
    kinds = {t: (Path(tracks_of(manifest)[t]["file"]).suffix,
                 codec_of(built / tracks_of(manifest)[t]["file"]))
             for t in loops}
    unsafe = {(".mp3", "mp3"), (".webm", "opus"), (".ogg", "vorbis")}
    assert {t: k for t, k in kinds.items() if k in unsafe} == {}


SCRIPT = re.compile(rb'__kineticAudio\("([^"\\]*)","([A-Za-z0-9+/]*={0,2})"'
                    rb'\);\n')


def test_every_track_has_its_script(built: Path, manifest: dict) -> None:
    """Beside each track file, `<file>.js` hands the player its bytes:
    one line naming the file, its bytes in base64."""
    for track in tracks_of(manifest).values():
        found = SCRIPT.fullmatch((built / f"{track['file']}.js").read_bytes())
        assert found is not None, track["file"]
        assert found.group(1).decode() == track["file"]
        assert base64.b64decode(found.group(2), validate=True) == \
            (built / track["file"]).read_bytes()


def test_track_durations_are_decoded_lengths(built: Path, manifest: dict,
                                             tmp_path: Path) -> None:
    wrong = {}
    for track_id, track in tracks_of(manifest).items():
        seconds = decoded_seconds(built / track["file"], tmp_path)
        if abs(seconds - track["durationSeconds"]) > 1e-6:
            wrong[track_id] = (track["durationSeconds"], seconds)
    assert wrong == {}


def test_join_sets_no_music_and_its_routes_set_different_music(
        manifest: dict) -> None:
    items = manifest["items"]
    index = {item["id"]: i for i, item in enumerate(items)}
    joins = [d for d in manifest["branches"] if "continueAt" in d]
    assert len(joins) == 1
    decision = joins[0]
    join = items[index[decision["continueAt"]]]
    assert "music" not in join.get("audio", {})

    def music_left_by(route: dict) -> str | None:
        left = None
        for item in items[index[route["start"]]:index[route["end"]] + 1]:
            left = item.get("audio", {}).get("music", left)
        return left

    left = [music_left_by(route) for route in decision["routes"]]
    assert len(left) == 2
    assert None not in left
    assert left[0] != left[1]
    # Each route reaches the join: the continuing one and a "continue" one.
    assert {route.get("result") for route in decision["routes"]
            if route["id"] != decision["continuingRoute"]} == {"continue"}


def test_a_voice_line_outlasts_its_text(manifest: dict) -> None:
    tracks = tracks_of(manifest)
    outlasting = [
        item["id"] for item in manifest["items"]
        if "voice" in item.get("audio", {})
        and tracks[item["audio"]["voice"]]["durationSeconds"]
        > max(MIN_HOLD_SECONDS, len(item.get("text", "")) * SECONDS_PER_CHAR)
        + 1
    ]
    assert outlasting != []


def test_video_sound_lasts_as_long_as_its_video(manifest: dict) -> None:
    tracks = tracks_of(manifest)
    videos = [item for item in manifest["items"]
              if "videoSound" in item.get("audio", {})]
    assert len(videos) == 1
    video = videos[0]
    assert {"startSeconds", "endSeconds", "loopStartSeconds"} <= set(video)
    sound = tracks[video["audio"]["videoSound"]["track"]]
    assert abs(sound["durationSeconds"] - video["durationSeconds"]) < 0.001
