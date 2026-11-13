"""The script beside each audio file (docs/content-format.md, "Audio";
docs/plan.md Phase 47, item 17).

Every writer (kinetic-media, kinetic-extract, the fixture builders,
tools/assemble_folder.py) makes a track's script with
``audio_format.script_bytes``: one ASCII line calling the player's
``__kineticAudio`` with the file's path and its bytes in base64. The
shape is read back here with the tests' own parser (``helpers``).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from helpers import script_holds
from kinetic_extract import audio_format

FILE = "media/ab/abc.webm"
# Every byte value, so base64's whole alphabet and its padding appear.
DATA = bytes(range(256)) * 3 + b"\x00\xff"


def put(folder: Path, file: str, data: bytes) -> None:
    (folder / file).parent.mkdir(parents=True, exist_ok=True)
    (folder / file).write_bytes(data)


def test_script_is_one_ascii_line_naming_the_file_and_holding_its_bytes(
        tmp_path: Path) -> None:
    script = audio_format.script_bytes(FILE, DATA)
    assert script.isascii()
    assert script.count(b"\n") == 1 and script.endswith(b");\n")
    assert script.startswith(b'__kineticAudio("media/ab/abc.webm","')
    put(tmp_path, FILE + ".js", script)
    assert script_holds(tmp_path, FILE) == DATA


def test_same_bytes_and_path_give_the_same_script() -> None:
    assert audio_format.script_bytes(FILE, DATA) == \
        audio_format.script_bytes(FILE, bytes(DATA))
    assert audio_format.script_bytes(FILE, DATA) != \
        audio_format.script_bytes("media/ab/abd.webm", DATA)


def test_empty_file_gives_an_empty_payload(tmp_path: Path) -> None:
    put(tmp_path, "a.wav.js", audio_format.script_bytes("a.wav", b""))
    assert script_holds(tmp_path, "a.wav") == b""


def test_write_script_writes_it_beside_the_file(tmp_path: Path) -> None:
    put(tmp_path, FILE, DATA)
    made = audio_format.write_script(tmp_path, FILE)
    assert (tmp_path / f"{FILE}.js").read_bytes() == made
    assert script_holds(tmp_path, FILE) == DATA


def test_write_script_leaves_a_right_one_and_replaces_a_wrong_one(
        tmp_path: Path) -> None:
    put(tmp_path, FILE, DATA)
    audio_format.write_script(tmp_path, FILE)
    script = tmp_path / f"{FILE}.js"
    os.utime(script, (1, 1))
    audio_format.write_script(tmp_path, FILE)
    assert script.stat().st_mtime == 1
    script.write_bytes(b"stale\n")
    audio_format.write_script(tmp_path, FILE)
    assert script_holds(tmp_path, FILE) == DATA
    assert [p.name for p in script.parent.iterdir()] == ["abc.webm",
                                                         "abc.webm.js"]


@pytest.mark.parametrize(("script", "says"), [
    (b"window.x = 1;\n", "not one __kineticAudio"),
    (audio_format.script_bytes("media/ab/other.webm", DATA),
     "names 'media/ab/other.webm'"),
    (audio_format.script_bytes(FILE, DATA[:-1]), "holds 769 bytes"),
    (audio_format.script_bytes(FILE, DATA).replace(b'",', b'", '),
     "not one __kineticAudio"),
])
def test_script_problem_says_what_is_wrong(script: bytes, says: str) -> None:
    problem = audio_format.script_problem(FILE, script, DATA)
    assert problem is not None and says in problem


def test_the_right_script_has_no_problem() -> None:
    assert audio_format.script_problem(
        FILE, audio_format.script_bytes(FILE, DATA), DATA) is None
