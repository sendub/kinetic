"""kinetic-extract reads Ren'Py audio (docs/plan.md Phase 47, item 8).

Each statement form and mapping rule has a synthetic `.rpy` case walked
through the parser and the timeline: the per-item cues (track ids in
the content format's item `audio` shape) and the tracks they name are
what the shipping step (item 9) turns into manifest audio. The two old
faults have regressions: `voice "file"` became dialogue spoken by
`voice`, and a menu whose choice block held a `play` or `stop` was
rejected. Every form that is not converted has a report line. The CLI
checks show the cues in the build ledger while the manifest stays
without audio until the files ship.
"""

from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

from PIL import Image

from kinetic_extract.audio_cues import AudioFiles, carry_dropped_audio
from kinetic_extract.cli import main as cli_main
from kinetic_extract.parser import parse_project
from kinetic_extract.rpa import AssetArchives
from kinetic_extract.timeline import ItemRecord, TimelineResult, build_timeline
from test_rpa import write_rpa

REPO_ROOT = Path(__file__).resolve().parents[2]


def make_game(tmp_path: Path, script: str, files: tuple[str, ...] = (),
              extra: dict[str, str] | None = None) -> Path:
    """A project dir holding game/script.rpy (dedented), empty stand-in
    files at the given game-relative paths, and extra scripts."""
    game = tmp_path / "proj" / "game"
    game.mkdir(parents=True)
    (game / "script.rpy").write_text(textwrap.dedent(script),
                                     encoding="utf-8")
    for rel in files:
        path = game / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"stand-in")
    for name, text in (extra or {}).items():
        (game / name).write_text(textwrap.dedent(text), encoding="utf-8")
    return game


def walk(tmp_path: Path, script: str, files: tuple[str, ...] = (),
         extra: dict[str, str] | None = None,
         ) -> tuple[TimelineResult, list[str]]:
    """Parse and walk a synthetic game; (result, report reasons)."""
    game = make_game(tmp_path, script, files, extra)
    parses, image_defs, characters, _sources = parse_project(game)
    result = build_timeline(parses, image_defs, characters, game,
                            audio_files=AudioFiles(game))
    reasons = [r.reason for _rel, parsed in parses for r in parsed.reports]
    return result, reasons


def cues(result: TimelineResult) -> list[dict[str, Any] | None]:
    return [record.audio for record in result.items]


def by_text(result: TimelineResult) -> dict[str, dict[str, Any] | None]:
    return {record.item.get("text"): record.audio for record in result.items}


def has(reasons: list[str], fragment: str) -> bool:
    return any(fragment in reason for reason in reasons)


# --- music -------------------------------------------------------------------

def test_play_music_becomes_the_next_item_music(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        label start:
            "Before."
            play music "music/theme.ogg"
            "One."
            "Two."
        """, files=("music/theme.ogg",))
    assert cues(result) == [None, {"music": "theme"}, None]
    track = result.audio_tracks["theme"]
    assert track.asset == "game/music/theme.ogg"
    assert track.source_ref == {"path": "game/music/theme.ogg"}
    assert track.local_path() == tmp_path / "proj/game/music/theme.ogg"
    assert (track.start_seconds, track.loop_start_seconds, track.volume,
            track.loop) == (0.0, None, 1.0, True)
    assert track.fields() == {}
    assert reasons == []


def test_fades_become_fade_ms(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        play music "m.ogg" fadein 1.5
        "One."
        stop music fadeout 2.0
        "Two."
        play music "m.ogg"
        "Three."
        stop music
        "Four."
        """, files=("m.ogg",))
    assert cues(result) == [
        {"music": "m", "fadeMs": 1500},
        {"music": None, "fadeMs": 2000},
        {"music": "m"},
        {"music": None},
    ]


def test_noloop_music_is_its_own_track(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        play music "m.ogg" noloop
        "One."
        play music "m.ogg"
        "Two."
        """, files=("m.ogg",))
    assert cues(result) == [{"music": "m"}, {"music": "m-2"}]
    assert result.audio_tracks["m"].fields() == {"loop": False}
    assert result.audio_tracks["m-2"].loop is True


def test_queue_alone_plays_and_if_changed_is_read(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        queue music "a.ogg"
        "One."
        play music "b.ogg" if_changed
        "Two."
        """, files=("a.ogg", "b.ogg"))
    assert cues(result) == [{"music": "a"}, {"music": "b"}]
    assert reasons == []


# --- one-shots and ambience --------------------------------------------------

def test_play_sound_is_a_one_shot_on_its_channel(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        play sound "sfx/door.ogg"
        "One."
        play sound "sfx/a.ogg"
        play sound "sfx/b.ogg"
        "Two."
        """, files=("sfx/door.ogg", "sfx/a.ogg", "sfx/b.ogg"))
    # Two plays on one channel before a line: the second cut the first.
    assert cues(result) == [
        {"sfx": [{"track": "door", "channel": "sound"}]},
        {"sfx": [{"track": "b", "channel": "sound"}]},
    ]


def test_play_audio_one_shots_overlap(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        play audio "a.ogg"
        play audio "b.ogg"
        "One."
        """, files=("a.ogg", "b.ogg"))
    assert cues(result) == [{"sfx": [{"track": "a"}, {"track": "b"}]}]


def test_loops_on_other_channels_make_the_ambience_set(tmp_path: Path,
                                                      ) -> None:
    result, reasons = walk(tmp_path, """
        init python:
            renpy.music.register_channel("nature", "sfx", True)
        label start:
            play sound "rain.ogg" loop
            "One."
            play nature "birds.ogg"
            "Two."
            play music "m.ogg"
            "Three."
            stop sound fadeout 0.5
            "Four."
            play nature "thunder.ogg" noloop
            "Five."
        """, files=("rain.ogg", "birds.ogg", "m.ogg", "thunder.ogg"))
    assert cues(result) == [
        {"ambience": ["rain"]},
        {"ambience": ["rain", "birds"]},
        {"music": "m"},
        {"ambience": ["birds"], "fadeMs": 500},
        # A play stops what its channel was playing, the loop included.
        {"ambience": [], "sfx": [{"track": "thunder", "channel": "nature"}]},
    ]
    assert reasons == []


def test_stop_audio_changes_nothing(tmp_path: Path) -> None:
    """Ren'Py's audio channel plays each sound on a fresh sub-channel,
    so `stop audio` reaches none of them (renpy/audio/audio.py
    get_channel): its loops play on."""
    result, _ = walk(tmp_path, """
        play audio "rain.ogg" loop
        "One."
        stop audio
        "Two."
        """, files=("rain.ogg",))
    assert cues(result) == [{"ambience": ["rain"]}, None]


def test_registered_channel_forms(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        init python:
            renpy.music.register_channel(name='fx', mixer="sfx",
                                         loop=False, tight=True)
            renpy.music.register_channel("amb", mixer="sfx",
                                         loop=None)
            renpy.music.register_channel("bed", "sfx")
            renpy.music.register_channel(ch, mixer="sfx")
        label start:
            play fx "a.ogg"
            "One."
            play amb "b.ogg"
            "Two."
            play foo "c.ogg"
            "Three."
            play bed "d.ogg"
            "Four."
        """, files=("a.ogg", "b.ogg", "c.ogg", "d.ogg"))
    assert cues(result) == [
        {"sfx": [{"track": "a", "channel": "fx"}]},
        {"ambience": ["b"]},
        None,
        # A channel registered with no loop argument loops.
        {"ambience": ["b", "d"]},
    ]
    assert has(reasons, "register_channel with arguments that are not "
                        "literals")
    assert has(reasons, "audio channel 'foo' is not registered")


def test_explicit_none_loop_follows_the_games_renpy(tmp_path: Path) -> None:
    """`loop=None` loops up to Ren'Py 8.3; from 8.4 it does not."""
    game = make_game(tmp_path, """
        init python:
            renpy.music.register_channel("amb", "sfx", None)
        play amb "b.ogg"
        "One."
        """, files=("b.ogg",))
    renpy_dir = game.parent / "renpy"
    renpy_dir.mkdir()
    (renpy_dir / "vc_version.py").write_text(
        "branch = 'fix'\nversion = '8.4.1.25072401'\n", encoding="utf-8")
    parses, image_defs, characters, _ = parse_project(game)
    result = build_timeline(parses, image_defs, characters, game)
    assert cues(result) == [{"sfx": [{"track": "b", "channel": "amb"}]}]


# --- voice -------------------------------------------------------------------

def test_voice_is_the_lines_voice_not_dialogue(tmp_path: Path) -> None:
    """Regression: `voice "file"` was read as a line spoken by `voice`."""
    result, reasons = walk(tmp_path, """
        define e = Character("Eileen")
        label start:
            voice "voice/e001.ogg"
            e "Hello."
            "Narration."
        """, files=("voice/e001.ogg",))
    assert [r.item.get("text") for r in result.items] == [
        "Hello.", "Narration."]
    assert [r.item.get("speaker") for r in result.items] == ["Eileen", None]
    assert cues(result) == [{"voice": "e001"}, None]
    assert reasons == []


def test_voice_waits_for_the_next_line(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        image one = "one.png"
        image two = "two.png"
        voice "v.ogg"
        scene one
        scene two
        "Spoken."
        """, files=("one.png", "two.png", "v.ogg"))
    assert [(r.item["type"], r.item.get("text")) for r in result.items] == [
        ("image", None), ("image", "Spoken.")]
    assert cues(result) == [None, {"voice": "v"}]


def test_voice_filename_format_and_audio_fallback(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        define config.voice_filename_format = "voice/{filename}.ogg"
        voice "e001"
        "One."
        play music "theme.ogg"
        "Two."
        """, files=("voice/e001.ogg", "audio/theme.ogg"))
    assert cues(result) == [{"voice": "e001"}, {"music": "theme"}]
    assert result.audio_tracks["e001"].asset == "game/voice/e001.ogg"
    # Ren'Py loads audio from game/audio/ when game/ lacks the file.
    assert result.audio_tracks["theme"].asset == "game/audio/theme.ogg"


def test_missing_files_drop_their_cues(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        voice "voice/gone.ogg"
        "One."
        play music "gone.ogg"
        "Two."
        voice sustain
        "Three."
        """)
    assert cues(result) == [None, None, None]
    assert has(reasons, "voice file 'voice/gone.ogg' missing: cue dropped")
    assert has(reasons, "audio file 'gone.ogg' missing: cue dropped")
    assert has(reasons, "voice sustain not converted")
    assert result.audio_tracks == {}


def test_voice_drops_with_its_unresolved_line(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        voice "v.ogg"
        scene nowhere
        "Dropped with its visual."
        scene black
        "Kept."
        """, files=("v.ogg",))
    assert by_text(result) == {"Kept.": None}
    assert has(reasons, "voice dropped with its line")


# --- names, files and partial specs ------------------------------------------

def test_defined_audio_names(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        define audio.theme = "music/theme.ogg"
        init python:
            audio.door = "sfx/door.ogg"
        label start:
            play music theme
            "One."
            play music audio.theme
            play sound door
            "Two."
        """, files=("music/theme.ogg", "sfx/door.ogg"))
    assert cues(result) == [
        {"music": "theme"},
        {"music": "theme", "sfx": [{"track": "door", "channel": "sound"}]},
    ]


def test_automatic_audio_names(tmp_path: Path) -> None:
    """Ren'Py names each file under game/audio/ (any depth, extensions
    .wav .mp2 .mp3 .ogg .opus .flac) by its base name lowercased; the
    first path in sorted order wins a clash, and a define wins over
    both (renpy/common/00audio.rpy)."""
    result, reasons = walk(tmp_path, """
        define audio.kept = "other/kept.wav"
        play music rain_loop
        play sound x
        "One."
        play sound kept
        "Two."
        play music Rain_Loop
        play sound readme
        "Three."
        """, files=("audio/bgm/Rain_Loop.ogg", "audio/a/x.ogg",
                    "audio/b/x.mp3", "audio/kept.ogg", "other/kept.wav",
                    "audio/readme.txt"))
    assert cues(result)[:2] == [
        {"music": "Rain_Loop", "sfx": [{"track": "x", "channel": "sound"}]},
        {"sfx": [{"track": "kept", "channel": "sound"}]},
    ]
    assert result.audio_tracks["Rain_Loop"].asset == \
        "game/audio/bgm/Rain_Loop.ogg"
    assert result.audio_tracks["x"].asset == "game/audio/a/x.ogg"
    assert result.audio_tracks["kept"].asset == "game/other/kept.wav"
    assert cues(result)[2] is None
    assert has(reasons, "audio name 'Rain_Loop' is not defined")
    assert has(reasons, "audio name 'readme' is not defined")


def test_archive_members_and_names(tmp_path: Path) -> None:
    game = make_game(tmp_path, """
        play music theme
        play sound "sfx/door.ogg"
        "One."
        """)
    write_rpa(game / "audio.rpa", {"audio/theme.ogg": b"t",
                                   "sfx/door.ogg": b"d"})
    parses, image_defs, characters, _ = parse_project(game)
    result = build_timeline(parses, image_defs, characters, game,
                            audio_files=AudioFiles(game, AssetArchives(game)))
    assert cues(result) == [
        {"music": "theme", "sfx": [{"track": "door", "channel": "sound"}]}]
    track = result.audio_tracks["door"]
    assert track.asset == "game/audio.rpa!sfx/door.ogg"
    assert track.source_ref == {"archive": "game/audio.rpa",
                                "member": "sfx/door.ogg"}
    assert track.local_path().read_bytes() == b"d"
    assert result.audio_tracks["theme"].source_ref["member"] == \
        "audio/theme.ogg"


def test_partial_specs_become_start_and_loop_start(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        play music "<from 5 loop 2>m.ogg"
        "One."
        play music "<from 3>m.ogg"
        "Two."
        play music "<loop 0.0>m.ogg"
        "Three."
        play music "<from 1 to 4>m.ogg"
        "Four."
        """, files=("m.ogg",))
    assert cues(result) == [{"music": "m"}, {"music": "m-2"},
                            {"music": "m-3"}, {"music": "m-4"}]
    tracks = result.audio_tracks
    assert tracks["m"].fields() == {"startSeconds": 5.0,
                                    "loopStartSeconds": 2.0}
    assert tracks["m-2"].fields() == {"startSeconds": 3.0}
    assert tracks["m-3"].fields() == {}  # a loop at the start is the default
    assert tracks["m-4"].fields() == {"startSeconds": 1.0}
    assert has(reasons, "<to N> not converted")


def test_a_statement_over_several_lines_is_one_statement(tmp_path: Path,
                                                        ) -> None:
    """Found in the corpus: a playlist written over several lines. Its
    lines are not dialogue, and a `$` call may run on the same way."""
    result, reasons = walk(tmp_path, """
        play music [
            "a.ogg",
            "b.ogg",
        ] fadein 2
        $ renpy.sound.play("s.ogg",
                           channel="sound")
        "One."
        """, files=("a.ogg", "b.ogg", "s.ogg"))
    assert [r.item.get("text") for r in result.items] == ["One."]
    assert cues(result) == [{"music": "a", "fadeMs": 2000,
                             "sfx": [{"track": "s", "channel": "sound"}]}]
    assert has(reasons, "playlist: only the first track converted")


def test_a_file_named_like_a_clause(tmp_path: Path) -> None:
    """Found in the corpus: `play music loop` plays `audio.loop`; Ren'Py
    reads the file expression before any clause."""
    result, reasons = walk(tmp_path, """
        define audio.loop = "music/loop.ogg"
        play music loop fadein 1
        "One."
        play music loop loop
        "Two."
        """, files=("music/loop.ogg",))
    assert cues(result) == [{"music": "loop", "fadeMs": 1000},
                            {"music": "loop"}]
    assert reasons == []


def test_volume_is_the_tracks_volume(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        play sound "s.ogg" volume 0.5
        "One."
        play sound "s.ogg"
        "Two."
        play sound "s.ogg" volume 4
        "Three."
        """, files=("s.ogg",))
    # Clamped to 1, the last play is the plain track again.
    assert [c["sfx"][0]["track"] for c in cues(result)] == ["s", "s-2", "s-2"]
    assert result.audio_tracks["s"].fields() == {"volume": 0.5}
    assert result.audio_tracks["s-2"].fields() == {}
    assert has(reasons, "volume 4 is outside 0-1: clamped")


def test_track_ids_have_the_id_shape(tmp_path: Path) -> None:
    result, _ = walk(tmp_path, """
        play music "music/My Song (final).ogg"
        play sound "_click.ogg"
        "One."
        """, files=("music/My Song (final).ogg", "_click.ogg"))
    assert cues(result) == [{"music": "My-Song-final",
                             "sfx": [{"track": "click", "channel": "sound"}]}]


# --- Python calls ------------------------------------------------------------

def test_literal_python_calls(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        define audio.theme = "m.ogg"
        init python:
            renpy.music.register_channel("nature", "sfx", True)
        label start:
            $ renpy.music.play("m.ogg", loop=True, fadeout=1.0, fadein=2.0, if_changed=True)
            "One."
            $ renpy.sound.play("s.ogg", channel="nature")
            "Two."
            $ renpy.music.play("w.ogg", channel="nature")
            "Three."
            $ renpy.music.stop(fadeout=0.5)
            "Four."
            $ renpy.music.play(audio.theme)
            $ renpy.sound.play("s.ogg")
            "Five."
        """, files=("m.ogg", "s.ogg", "w.ogg"))
    assert cues(result) == [
        {"music": "m", "fadeMs": 2000},
        # renpy.sound.play never loops unless asked, whatever the channel.
        {"sfx": [{"track": "s", "channel": "nature"}]},
        {"ambience": ["w"]},
        {"music": None, "fadeMs": 500},
        {"music": "m", "sfx": [{"track": "s", "channel": "sound"}]},
    ]
    assert reasons == []


# --- menus -------------------------------------------------------------------

def test_audio_in_a_choice_block_keeps_the_menu(tmp_path: Path) -> None:
    """Regression: a `play` or `stop` in a choice block rejected the
    menu; now the cue attaches to the route's first item."""
    result, reasons = walk(tmp_path, """
        label start:
            play sound "rain.ogg" loop
            "Lead."
            menu:
                "Knock":
                    play sound "knock.ogg"
                    "You knock."
                "Leave":
                    stop sound
                    "You leave."
                    "Gone."
        """, files=("rain.ogg", "knock.ogg"))
    assert len(result.branch_candidates) == 1
    assert not has(reasons, "menu unsupported")
    assert by_text(result) == {
        "Lead.": {"ambience": ["rain"]},
        "You knock.": {"ambience": [],
                       "sfx": [{"track": "knock", "channel": "sound"}]},
        "You leave.": {"ambience": []},
        "Gone.": None,
    }


def test_a_cue_before_the_menu_reaches_every_route(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        "Lead."
        play music "m.ogg"
        voice "v.ogg"
        menu:
            "A":
                "A1."
                "A2."
            "B":
                "B1."
        "After."
        """, files=("m.ogg", "v.ogg"))
    assert by_text(result) == {"Lead.": None, "A1.": {"music": "m"},
                               "A2.": None, "B1.": {"music": "m"},
                               "After.": None}
    assert has(reasons, "voice before a menu: not converted")


def test_routes_start_from_the_state_before_the_menu(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        init python:
            renpy.music.register_channel("amb", "sfx", True)
            renpy.music.register_channel("amb2", "sfx", True)
            renpy.music.register_channel("amb3", "sfx", True)
        label start:
            play amb "rain.ogg"
            "Lead."
            menu:
                "A":
                    play amb2 "birds.ogg"
                    "A1."
                    play sound "door.ogg"
                "B":
                    play amb3 "wind.ogg"
                    "B1."
            "After."
            stop amb
            "Later."
        """, files=("rain.ogg", "birds.ogg", "wind.ogg", "door.ogg"))
    assert by_text(result) == {
        "Lead.": {"ambience": ["rain"]},
        # A cue after a route's last item stays in the route.
        "A1.": {"ambience": ["rain", "birds"],
                "sfx": [{"track": "door", "channel": "sound"}]},
        "B1.": {"ambience": ["rain", "wind"]},
        "After.": None,
        # The routes left different sets: the last route's is assumed.
        "Later.": {"ambience": ["wind"]},
    }
    assert has(reasons, "ambience after a menu whose routes leave "
                        "different sets")


def test_audio_in_an_unsupported_menu_is_reported(tmp_path: Path) -> None:
    _result, reasons = walk(tmp_path, """
        label start:
            "Lead."
            menu:
                "Go":
                    play sound "go.ogg"
                    jump elsewhere
                "Stay":
                    "You stay."
        """, files=("go.ogg",))
    assert has(reasons, "menu unsupported (jump inside a choice block")
    assert has(reasons, "audio inside an unsupported menu: not converted")


# --- forms not converted -----------------------------------------------------

def test_each_unconverted_form_is_reported(tmp_path: Path) -> None:
    result, reasons = walk(tmp_path, """
        init python:
            renpy.register_statement("sfx", parse=p, execute=e)
        screen hud():
            textbutton "Ring" action Play("sound", "ring.ogg")
        label start:
            play music ["a.ogg", "b.ogg"]
            "One."
            play music ["<silence 0.5>", "b.ogg"]
            "Two."
            play music "a.ogg"
            queue music "b.ogg"
            "Three."
            play sound "<silence 2>"
            $ renpy.music.set_volume(0.5)
            play music song
            play music "bgm/" + name
            sfx "boom"
            python:
                renpy.music.play("a.ogg")
            if flag:
                play sound "a.ogg"
            $ renpy.play("a.ogg")
            play movie "clip.webm"
            "Four."
            play sound "a.ogg"
        """, files=("a.ogg", "b.ogg", "ring.ogg"))
    assert cues(result) == [{"music": "a"}, {"music": "b"}, {"music": "a"},
                            None]
    for fragment in (
            "playlist: only the first track converted",
            "<silence> not converted",
            "queued after another track: not converted (the first plays)",
            "set_volume not converted",
            "audio name 'song' is not defined",
            "audio file named by an expression or variable",
            "creator-defined statement: not converted",
            "audio inside a skipped `screen` block: not converted",
            "audio inside a skipped `python` block: not converted",
            "audio inside a skipped `if` block: not converted",
            "audio Python other than a literal renpy.music or renpy.sound",
            "movie channel plays video: not converted",
            "audio cue after the last item: not converted"):
        assert has(reasons, fragment), fragment


# --- dropped items and the CLI -----------------------------------------------

def test_dropped_items_pass_their_audio_on() -> None:
    def record(item_id: str, audio: dict[str, Any] | None,
               skipped: bool = False) -> ItemRecord:
        rec = ItemRecord(item={"id": item_id, "type": "image"},
                         source="game/script.rpy:1", asset=None)
        rec.audio, rec.skipped = audio, skipped
        return rec

    records = [
        record("a", {"music": "m", "fadeMs": 2000, "voice": "v",
                     "sfx": [{"track": "s", "channel": "sound"}]},
               skipped=True),
        record("b", None, skipped=True),
        record("c", {"sfx": [{"track": "t"}], "fadeMs": 500}),
    ]
    carry_dropped_audio(records)
    assert records[2].audio == {
        "music": "m", "fadeMs": 2000,
        "sfx": [{"track": "s", "channel": "sound"}, {"track": "t"}]}
    assert records[0].audio is None
    assert any("voice dropped with the item" in n for n in records[0].notes)
    assert any("audio moved to c" in n for n in records[0].notes)


def png() -> bytes:
    from io import BytesIO

    buf = BytesIO()
    Image.new("RGB", (32, 18), "teal").save(buf, "PNG")
    return buf.getvalue()


def test_cli_keeps_cues_in_the_ledger_and_the_manifest_valid(
        tmp_path: Path, capsys: Any) -> None:
    game = make_game(tmp_path, """
        image bg = "bg.png"
        image broken = "broken.png"
        label start:
            scene bg
            play music "m.ogg"
            "One."
            play sound "s.ogg"
            scene broken
            "Dropped."
            "Two."
        """, files=("m.ogg", "s.ogg"))
    (game / "bg.png").write_bytes(png())
    (game / "broken.png").write_bytes(b"not an image")
    out = tmp_path / "out"
    assert cli_main([str(game.parent), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert "audio" not in manifest
    assert all("audio" not in item for item in manifest["items"])
    assert ledger["items"]["bg-001"]["audio"] == {"music": "m"}
    # The dropped item's one-shot moved to the next item kept.
    assert ledger["items"]["line-003"]["audio"] == {
        "sfx": [{"track": "s", "channel": "sound"}]}
    assert ledger["audioTracks"] == {
        "m": {"asset": "game/m.ogg"}, "s": {"asset": "game/s.ogg"}}
    assert "audio: 2 items carry cues over 2 tracks" in \
        capsys.readouterr().out
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)], capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_cli_prefixes_track_ids_per_episode(tmp_path: Path) -> None:
    one = make_game(tmp_path / "e1", 'play music "m.ogg"\n"One."\n',
                    files=("m.ogg",))
    two = make_game(tmp_path / "e2", 'play music "m.ogg"\n"Two."\n',
                    files=("m.ogg",))
    out = tmp_path / "out"
    assert cli_main([str(one.parent), str(two.parent), str(out)]) == 0
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    assert sorted(ledger["audioTracks"]) == ["ep1-m", "ep2-m"]
    assert ledger["items"]["ep2-line-001"]["audio"] == {"music": "ep2-m"}
