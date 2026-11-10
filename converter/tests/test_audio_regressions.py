"""The two audio faults kinetic-extract had before Phase 47 item 8.

Kept apart from test_audio_extract.py and limited to the parser and
timeline calls that existed before the fix, so the same file runs red
against the old code: `voice "file"` became a line spoken by a
character called `voice`, and a menu whose choice block held a `play`
or `stop` was rejected (its routes lost).
"""

from __future__ import annotations

from pathlib import Path

from kinetic_extract.parser import parse_file
from kinetic_extract.timeline import build_timeline


def test_voice_statement_is_not_dialogue(tmp_path: Path) -> None:
    parsed = parse_file('define e = Character("Eileen")\n'
                        "label start:\n"
                        '    voice "voice/e001.ogg"\n'
                        '    e "Hello."\n', "game/script.rpy")
    result = build_timeline([("game/script.rpy", parsed)], {},
                            parsed.characters, tmp_path)
    assert [(r.item.get("speaker"), r.item.get("text"))
            for r in result.items] == [("Eileen", "Hello.")]


def test_play_and_stop_in_a_choice_block_keep_the_menu(tmp_path: Path,
                                                       ) -> None:
    parsed = parse_file("label start:\n"
                        '    "Lead."\n'
                        "    menu:\n"
                        '        "Knock":\n'
                        '            play sound "knock.ogg"\n'
                        '            "You knock."\n'
                        '        "Leave":\n'
                        "            stop music fadeout 1.0\n"
                        '            "You leave."\n', "game/script.rpy")
    result = build_timeline([("game/script.rpy", parsed)], {}, {}, tmp_path)
    assert [m.skip_reason for m in parsed.menus] == [None]
    assert [[label for label, _s, _e in c["route_spans"]]
            for c in result.branch_candidates] == [["Knock", "Leave"]]
    assert [r.item.get("text") for r in result.items] == [
        "Lead.", "You knock.", "You leave."]
