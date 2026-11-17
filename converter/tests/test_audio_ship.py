"""kinetic-extract ships the sound (docs/plan.md Phase 47, item 9).

Every audio file a cue names goes through kinetic-media's ``audio`` kind
into ``media/`` and the ledger, loose or from an ``.rpa``, and becomes a
manifest track with its measured ``durationSeconds``; the items carry
their cues in the manifest. A track that does not ship, or whose start
lies past its end, drops its cues; a loop point past the end plays the
track once. Each video item's file is also asked for its sound: an
audible soundtrack as long as the item becomes its ``videoSound``, and
silent, absent and too-short ones are counted in the summary.

Item 17: a source that music, ambience or a video's sound plays ships as
a looping request, in a loop-safe format (MP3 and Opus become AAC in
M4A), and every shipped track has its script beside it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
import wave
from pathlib import Path
from typing import Any

import pytest
from PIL import Image

from helpers import is_content_addressed, script_holds
from kinetic_extract import assets, media_tools
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.cli import main as cli_main
from kinetic_extract.media_cli import main as media_main
from test_rpa import write_rpa

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))


def tone(hz: int, seconds: float) -> list[str]:
    return ["-f", "lavfi", "-i",
            f"sine=frequency={hz}:sample_rate=22050:duration={seconds}"]


PICTURE = ["-f", "lavfi", "-i", "testsrc=size=64x36:rate=10:duration=1"]
H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
VORBIS = ["-c:a", "libvorbis"]
MP3 = ["-c:a", "libmp3lame"]


def ffmpeg(out: Path, args: list[str]) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([*media_tools.ffmpeg_cmd(), "-y", *args,
                           str(out)], capture_output=True, text=True,
                          check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr


def make_project(tmp_path: Path, script: str,
                 media: dict[str, list[str]] | None = None,
                 raw: dict[str, bytes] | None = None,
                 name: str = "proj") -> Path:
    """A project dir: game/script.rpy (dedented), a background picture
    `bg.png`, files made by ffmpeg (game path -> arguments) and raw
    files (game path -> bytes)."""
    game = tmp_path / name / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(textwrap.dedent(script), "utf-8")
    Image.new("RGB", (32, 18), "teal").save(game / "bg.png")
    for rel, args in (media or {}).items():
        ffmpeg(game / rel, args)
    for rel, data in (raw or {}).items():
        (game / rel).parent.mkdir(parents=True, exist_ok=True)
        (game / rel).write_bytes(data)
    return game.parent


def convert(project: Path | list[Path], out: Path,
            capsys: pytest.CaptureFixture[str]) -> tuple[dict, dict, str]:
    projects = project if isinstance(project, list) else [project]
    capsys.readouterr()
    assert cli_main([*map(str, projects), str(out)]) == 0
    printed = capsys.readouterr().out
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return manifest, ledger, printed


def validate(out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)], capture_output=True, text=True, check=False)


def assert_valid_without_warnings(out: Path) -> None:
    """Valid, with no warning but the translation ones: the demo's
    language files are partial on purpose (test_renpy_translations)."""
    proc = validate(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    warnings = [line for line in proc.stderr.splitlines()
                if "warning" in line and not line.startswith("warning: lang/")
                and not line.endswith(" translation warnings")]
    assert proc.stdout.strip() == "" and not warnings, proc.stderr


def audio_of(manifest: dict) -> dict[str, Any]:
    return {item["id"]: item.get("audio") for item in manifest["items"]}


def reasons(ledger: dict) -> list[str]:
    return [f"{r['source']}: {r['reason']}" for r in ledger["report"]]


# --- fixtures/renpy_demo -----------------------------------------------------

@pytest.fixture(scope="module")
def demo(tmp_path_factory: pytest.TempPathFactory,
         ) -> tuple[Path, dict, dict, str]:
    out = tmp_path_factory.mktemp("demo") / "out"
    proc = subprocess.run(
        [sys.executable, "-m", "kinetic_extract", str(FIXTURE), str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return out, manifest, ledger, proc.stdout


def test_demo_items_carry_their_cues(demo) -> None:
    _, manifest, _, _ = demo
    audio = audio_of(manifest)
    assert audio["bg-room-001"] == {"music": "theme", "ambience": ["rain"],
                                    "fadeMs": 2000}
    assert audio["line-002"] == {"voice": "viktor-01"}
    assert audio["line-003"] == {"sfx": [{"track": "door",
                                          "channel": "sound"}]}
    # The choice block's stop and play reach its route's first item.
    assert audio["bg-yard-010"] == {"music": "theme-2", "ambience": [],
                                    "fadeMs": 1000}
    # The movie with sound plays it; the one with no audio stream has none.
    assert audio["talk-020"] == {"videoSound": {"track": "talk"}}
    assert audio["clip-004"] is None
    assert sum(1 for a in audio.values() if a) == 5


def test_demo_tracks_ship_with_measured_durations(demo) -> None:
    out, manifest, _, _ = demo
    tracks = manifest["audio"]["tracks"]
    assert list(tracks) == ["theme", "rain", "viktor-01", "door", "theme-2",
                            "talk"]
    for track_id, track in tracks.items():
        assert is_content_addressed(out, track["file"]), track_id
        # The duration is the shipped file's own, decoded.
        assert track["durationSeconds"] == assets.decoded_duration(
            out / track["file"]), track_id
    lengths = {t: tracks[t]["durationSeconds"] for t in tracks}
    # The generator's lengths: 2 s, 1 s, 1.5 s, 0.3 s. The looping theme
    # is AAC, which the system ffmpeg decodes with up to one 1024-sample
    # frame of padding (the pinned one trims it).
    aac_frame = 1024 / 22050
    assert lengths["theme"] == pytest.approx(2.0, abs=aac_frame)
    assert lengths["rain"] == pytest.approx(1.0, abs=0.05)
    assert lengths["viktor-01"] == pytest.approx(1.5, abs=0.06)
    with wave.open(str(FIXTURE / "game/audio/door.wav")) as door:
        assert lengths["door"] == round(door.getnframes()
                                        / door.getframerate(), 6)
    # The 1 s movie's soundtrack, re-encoded from its MP3: as long as the
    # picture within the format's videoSound slack, whatever ffmpeg
    # trims of the MP3's and AAC's padding.
    assert lengths["talk"] == pytest.approx(1.0, abs=0.05)
    # One file, two ways of playing it: two ids.
    assert tracks["theme-2"] == {"file": tracks["theme"]["file"],
                                 "durationSeconds": lengths["theme"],
                                 "startSeconds": 0.5,
                                 "loopStartSeconds": 1.0}
    # Music, ambience and the soundtrack loop: loop-safe formats; the
    # voice line and the one-shot keep theirs.
    assert {t: tracks[t]["file"].rsplit(".", 1)[1] for t in tracks} == {
        "theme": "m4a", "rain": "webm", "viktor-01": "mp3", "door": "wav",
        "theme-2": "m4a", "talk": "m4a"}


def test_demo_tracks_have_their_scripts(demo) -> None:
    out, manifest, _, _ = demo
    for track_id, track in manifest["audio"]["tracks"].items():
        assert script_holds(out, track["file"]) == \
            (out / track["file"]).read_bytes(), track_id


def test_demo_ledger_records_the_sound(demo) -> None:
    _, manifest, ledger, _ = demo
    tracks = manifest["audio"]["tracks"]
    media = ledger["media"]
    theme = media[tracks["theme"]["file"]]
    assert theme["kind"] == "audio"
    assert theme["source"]["path"] == "game/audio/theme.mp3"
    (step,) = theme["steps"]
    assert step["step"] == "transcode" and "loops" in step["reason"]
    assert step["args"][step["args"].index("-c:a") + 1] == "aac"
    talk = media[tracks["talk"]["file"]]
    assert talk["source"]["path"] == "game/data/talk.mp4"
    (step,) = talk["steps"]
    assert step["step"] == "extract" and "mp3 sound" in step["reason"]
    assert step["args"][step["args"].index("-c:a") + 1] == "aac"
    assert media[tracks["viktor-01"]["file"]]["steps"] == [
        {"step": "preserve", "codec": "mp3"}]
    talk_track = ledger["audioTracks"]["talk"]
    assert {k: talk_track[k] for k in ("asset", "decision", "file")} == {
        "asset": "game/data/talk.mp4", "decision": "extract",
        "file": tracks["talk"]["file"]}
    assert any("max_volume" in n for n in talk_track["notes"])
    assert ledger["audioTracks"]["door"] == {
        "asset": "game/audio/door.wav", "decision": "copy",
        "file": tracks["door"]["file"]}
    # Both theme tracks name the one file.
    assert ledger["audioTracks"]["theme-2"]["file"] == tracks["theme"]["file"]
    assert ledger["items"]["talk-020"]["sound"] == "extract"
    assert ledger["items"]["clip-004"]["sound"] == "no audio"
    # The cues live in the manifest now, not in the ledger's items.
    assert all("audio" not in e for e in ledger["items"].values())


def test_demo_summary_counts_the_sound(demo) -> None:
    *_, printed = demo
    assert ("audio: 5 items carry sound; 6 tracks shipped (3 copy, "
            "1 extract, 2 transcode), 0 dropped") in printed
    assert "video soundtracks: 1 audible, 0 silent, 1 absent" in printed
    assert "ledger only" not in printed and "not shipped yet" not in printed


def test_demo_validates_and_rebuilds(
        demo, capsys: pytest.CaptureFixture[str]) -> None:
    out, _, ledger, _ = demo
    assert_valid_without_warnings(out)
    capsys.readouterr()
    assert media_main(["rebuild", str(FIXTURE), str(out)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in \
        capsys.readouterr().out


# --- loop-safe formats (item 17) ---------------------------------------------

def test_looping_sound_ships_loop_safe_and_the_rest_as_it_is(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path, """
        init python:
            renpy.music.register_channel("amb", "sfx", True)
        image bg = "bg.png"
        label start:
            scene bg
            play music "m.mp3"
            play amb "rain.opus"
            play sound "knock.mp3"
            voice "v.mp3"
            "One."
            play music "once.mp3" noloop
            "Two."
            movie "talk.mp4"
            "Three."
            stop movie
        """, media={"m.mp3": [*tone(440, 1), *MP3],
                    "rain.opus": [*tone(220, 1), "-c:a", "libopus"],
                    "knock.mp3": [*tone(880, 0.3), *MP3],
                    "v.mp3": [*tone(330, 1), *MP3],
                    "once.mp3": [*tone(550, 1), *MP3],
                    "talk.mp4": [*PICTURE, *tone(660, 1), *H264,
                                 "-c:a", "libopus", "-shortest"]})
    out = tmp_path / "out"
    manifest, ledger, printed = convert(project, out, capsys)
    tracks = manifest["audio"]["tracks"]
    shipped = {t: (ledger["audioTracks"][t]["decision"],
                   tracks[t]["file"].rsplit(".", 1)[1]) for t in tracks}
    assert shipped == {"m": ("transcode", "m4a"),
                       "rain": ("transcode", "m4a"),
                       "knock": ("copy", "mp3"), "v": ("copy", "mp3"),
                       "once": ("copy", "mp3"),
                       "talk": ("extract", "m4a")}
    for track in tracks.values():
        assert script_holds(out, track["file"]) == \
            (out / track["file"]).read_bytes()
    assert_valid_without_warnings(out)
    capsys.readouterr()
    assert media_main(["rebuild", str(project), str(out)]) == 0
    assert "rebuild OK" in capsys.readouterr().out


# --- tracks that do not ship -------------------------------------------------

def test_a_track_that_does_not_ship_drops_its_cues(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path, """
        init python:
            renpy.music.register_channel("amb", "sfx", True)
        image bg = "bg.png"
        label start:
            scene bg
            play music "m.ogg"
            play amb "rain.ogg"
            play sound "bad.ogg"
            "One."
            play amb "bad.ogg"
            voice "bad.ogg"
            "Two."
        """, media={"m.ogg": [*tone(440, 1), *VORBIS],
                    "rain.ogg": [*tone(220, 1), *VORBIS]},
        raw={"bad.ogg": b"not audio at all" * 8})
    out = tmp_path / "out"
    manifest, ledger, printed = convert(project, out, capsys)
    assert list(manifest["audio"]["tracks"]) == ["m", "rain"]
    assert audio_of(manifest) == {
        "bg-001": {"music": "m", "ambience": ["rain"]},
        "line-002": {"ambience": []},
    }
    assert ledger["audioTracks"]["bad"]["decision"] == "skipped"
    assert "file" not in ledger["audioTracks"]["bad"]
    assert any(r.startswith("game/bad.ogg: not shipped (skipped: "
                            "unprobeable audio bad.ogg") and
               r.endswith("its cues dropped") for r in reasons(ledger))
    assert "2 tracks shipped (2 remux), 1 dropped" in printed
    assert_valid_without_warnings(out)


def test_start_past_the_end_drops_the_track_and_loop_past_it_plays_once(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path, """
        image bg = "bg.png"
        label start:
            scene bg
            play music "<from 5.0>m.mp3"
            "One."
            play music "<loop 5.0>m.mp3"
            "Two."
        """, media={"m.mp3": [*tone(440, 1), "-c:a", "libmp3lame"]})
    out = tmp_path / "out"
    manifest, ledger, _ = convert(project, out, capsys)
    tracks = manifest["audio"]["tracks"]
    assert list(tracks) == ["m-2"]
    assert tracks["m-2"]["loop"] is False
    assert "loopStartSeconds" not in tracks["m-2"]
    assert audio_of(manifest) == {"bg-001": None, "line-002": {"music": "m-2"}}
    found = reasons(ledger)
    assert any("startSeconds 5.0 is not before the end" in r
               and r.endswith("its cues dropped") for r in found), found
    assert any("loopStartSeconds 5.0 is not before the end" in r
               and "plays once" in r for r in found), found
    assert_valid_without_warnings(out)


def test_stops_with_nothing_ever_playing_leave_no_audio(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # A stop when no track ships anywhere stops nothing; kept, it would
    # be an item `audio` with no top-level tracks, which never validates.
    project = make_project(tmp_path, """
        image bg = "bg.png"
        label start:
            scene bg
            stop music fadeout 1.0
            "One."
            play sound "bad.ogg"
            "Two."
        """, raw={"bad.ogg": b"not audio at all" * 8})
    out = tmp_path / "out"
    manifest, _, printed = convert(project, out, capsys)
    assert "audio" not in manifest
    assert audio_of(manifest) == {"bg-001": None, "line-002": None}
    assert "0 items carry sound; 0 tracks shipped, 1 dropped" in printed
    assert_valid_without_warnings(out)


# --- video soundtracks -------------------------------------------------------

def test_video_soundtracks(tmp_path: Path,
                           capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path, """
        label start:
            movie "loud.mp4"
            "Loud."
            stop movie
            movie "quiet.mp4"
            "Quiet."
            stop movie
            movie "mute.mp4"
            "Mute."
            stop movie
            movie "short.mp4"
            "Short."
            stop movie
            movie "loud.mp4"
            "Loud again."
            stop movie
        """, media={
            "loud.mp4": [*PICTURE, *tone(660, 1), *H264, "-c:a", "aac",
                         "-shortest"],
            "quiet.mp4": [*PICTURE, "-f", "lavfi", "-i",
                          "anullsrc=r=22050:cl=mono", *H264, "-c:a", "aac",
                          "-shortest"],
            "mute.mp4": [*PICTURE, *H264, "-an"],
            # A 1 s picture over 0.4 s of sound.
            "short.mp4": [*PICTURE, *tone(660, 0.4), *H264, "-c:a", "aac"],
        })
    out = tmp_path / "out"
    manifest, ledger, printed = convert(project, out, capsys)
    assert list(manifest["audio"]["tracks"]) == ["loud"]
    loud = manifest["audio"]["tracks"]["loud"]
    assert set(loud) == {"file", "durationSeconds"}
    assert ledger["media"][loud["file"]]["steps"][0]["step"] == "extract"
    assert audio_of(manifest) == {
        "loud-001": {"videoSound": {"track": "loud"}},
        "quiet-002": None,
        "mute-003": None,
        "short-004": None,
        "loud-005": {"videoSound": {"track": "loud"}},
    }
    sound = {i: e["sound"] for i, e in ledger["items"].items()}
    assert sound == {"loud-001": "extract", "quiet-002": "silent",
                     "mute-003": "no audio", "short-004": "extract",
                     "loud-005": "extract"}
    notes = ledger["items"]["short-004"]["notes"]
    assert any("shorter than the item's range end" in n for n in notes)
    assert ("video soundtracks: 2 audible, 1 silent, 1 absent, 1 too short"
            in printed)
    assert_valid_without_warnings(out)


# --- archives, re-encodes and rebuild ----------------------------------------

def test_archived_and_reencoded_audio_ships_and_rebuilds(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    project = make_project(tmp_path, """
        image bg = "bg.png"
        label start:
            scene bg
            play music "music/theme.ogg"
            play sound "beep.aiff"
            "One."
            movie "talk.mp4"
            "Two."
            stop movie
        """, media={
            "beep.aiff": [*tone(880, 0.3), "-c:a", "pcm_s16be"],
            "talk.mp4": [*PICTURE, *tone(660, 1), *H264, "-c:a", "aac",
                         "-shortest"],
            "src/theme.ogg": [*tone(440, 1), *VORBIS],
        })
    game = project / "game"
    write_rpa(game / "sounds.rpa",
              {"music/theme.ogg": (game / "src/theme.ogg").read_bytes()})
    (game / "src/theme.ogg").unlink()
    out = tmp_path / "out"
    manifest, ledger, _ = convert(project, out, capsys)
    tracks = manifest["audio"]["tracks"]
    assert list(tracks) == ["theme", "beep", "talk"]
    entries = {t: ledger["media"][tracks[t]["file"]] for t in tracks}
    assert entries["theme"]["source"]["archive"] == "game/sounds.rpa"
    assert entries["theme"]["source"]["member"] == "music/theme.ogg"
    assert [e["steps"][-1]["step"] for e in entries.values()] == [
        "remux", "transcode", "extract"]
    assert [tracks[t]["file"].rsplit(".", 1)[1] for t in tracks] == [
        "webm", "webm", "m4a"]
    assert_valid_without_warnings(out)
    capsys.readouterr()
    assert media_main(["rebuild", str(project), str(out)]) == 0
    assert f"{len(ledger['media'])} matched, 0 failed" in \
        capsys.readouterr().out


# --- several episodes --------------------------------------------------------

def test_episode_tracks_name_their_project(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    script = """
        image bg = "bg.png"
        label start:
            scene bg
            play music "m.ogg"
            "{line}"
            movie "talk.mp4"
            "Watch."
            stop movie
        """
    talk = [*PICTURE, *tone(660, 1), *H264, "-c:a", "aac", "-shortest"]
    one = make_project(tmp_path, script.format(line="One."),
                       media={"m.ogg": [*tone(440, 1), *VORBIS],
                              "talk.mp4": talk}, name="one")
    two = make_project(tmp_path, script.format(line="Two."),
                       media={"m.ogg": [*tone(330, 1), *VORBIS],
                              "talk.mp4": talk}, name="two")
    out = tmp_path / "out"
    manifest, ledger, _ = convert([one, two], out, capsys)
    tracks = manifest["audio"]["tracks"]
    assert list(tracks) == ["ep1-m", "ep2-m", "ep1-talk", "ep2-talk"]
    assert audio_of(manifest)["ep2-bg-001"] == {"music": "ep2-m"}
    assert audio_of(manifest)["ep2-talk-002"] == {
        "videoSound": {"track": "ep2-talk"}}
    for n in (1, 2):
        entry = ledger["media"][tracks[f"ep{n}-m"]["file"]]
        assert entry["source"]["project"] == n
    assert_valid_without_warnings(out)
    capsys.readouterr()
    assert media_main(["rebuild", str(one), str(two), str(out)]) == 0
    assert "rebuild OK" in capsys.readouterr().out
