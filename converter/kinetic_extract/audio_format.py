"""What the player needs of an audio file (docs/content-format.md,
"Audio"; docs/plan.md Phase 47, item 17): the script that hands it the
file's bytes, and a format whose loops restart on the right sample.

The script. Under file:// in Chrome, fetch fails and a media-element
source outputs zeros, so the player reads a track's bytes from a classic
script it adds to the page. Beside each audio file ``F`` the folder
ships ``F.js``, one ASCII line::

    __kineticAudio("F","<base64 of F's bytes>");

``F`` is the track's ``file`` exactly as the manifest names it, written
as a JSON string; the base64 is RFC 4648's standard alphabet with
padding and no line breaks; one ``\\n`` ends the line. The player defines
``__kineticAudio`` before adding the script. The script is a function of
the path and the bytes alone, so every writer (kinetic-media,
kinetic-extract, the fixture builders, tools/assemble_folder.py) makes
the same bytes, and the validator checks a script against its file.

Loop-safe formats. The player loops a track's decoded samples from
``loopStartSeconds`` to ``durationSeconds``, so a decoder that shifts
the start moves every wrap. ``LOOP_UNSAFE`` lists the formats whose
``decodeAudioData`` shifted the start in Chrome or WebKit, measured
against the lossless source (item 16). AAC in M4A, Vorbis in WebM, WAV,
FLAC and Opus in Ogg start exactly in both; the samples some of them add
at the end lie past the track's true length.

Standard library only: tools/ and fixtures/ import this module straight
from converter/, without the converter installed.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from pathlib import Path

__all__ = ["FUNCTION", "LOOP_UNSAFE", "SUFFIX", "read_script",
           "script_bytes", "script_path", "script_problem", "write_script"]

FUNCTION = "__kineticAudio"
SUFFIX = ".js"

# (extension, codec) -> (the format's name, what decodeAudioData does to
# its start), measured 2026-11-11 on a 2.000 s noise probe against its
# lossless source (docs/progress.md, item 16). The Ogg family (.ogg,
# .oga, .opus) is "ogg" here.
LOOP_UNSAFE = {
    ("mp3", "mp3"): ("MP3", "WebKit decodes it 576 samples late"),
    ("webm", "opus"): ("Opus in WebM",
                       "Chrome's decode loses its first 24 samples"),
    ("ogg", "vorbis"): ("Vorbis in Ogg",
                        "WebKit's decode loses its first 128 samples"),
}

_SHAPE = re.compile(rb'__kineticAudio\(("(?:[^"\\]|\\.)*"),'
                    rb'"([A-Za-z0-9+/]*={0,2})"\);\n')


def script_bytes(file: str, data: bytes) -> bytes:
    """The script of the audio bytes `data` that the manifest names
    `file`."""
    payload = base64.b64encode(data).decode("ascii")
    return f'{FUNCTION}({json.dumps(file)},"{payload}");\n'.encode("ascii")


def script_path(folder: Path, file: str) -> Path:
    """Where the script of the folder's audio file `file` lives."""
    return folder / f"{file}{SUFFIX}"


def read_script(script: bytes) -> tuple[str, bytes] | None:
    """(the file it names, the bytes it holds) of a script in the shape
    above, or None."""
    found = _SHAPE.fullmatch(script)
    if found is None:
        return None
    try:
        name = json.loads(found.group(1))
        data = base64.b64decode(found.group(2), validate=True)
    except (ValueError, binascii.Error):
        return None
    return (name, data) if isinstance(name, str) else None


def script_problem(file: str, script: bytes, data: bytes) -> str | None:
    """Why `script` is not the script of `file` holding `data`, or None."""
    if script == script_bytes(file, data):
        return None
    found = read_script(script)
    if found is None:
        return f'it is not one {FUNCTION}("<file>","<base64>"); line'
    name, held = found
    if name != file:
        return f"it names {name!r}, not {file!r}"
    if held != data:
        return (f"it holds {len(held)} bytes that are not the file's "
                f"{len(data)}")
    return "it is not written the one way every writer writes it"


def write_script(folder: Path, file: str) -> bytes:
    """Make `folder`'s script for its audio file `file` hold that file's
    bytes, and return the script. One that already does is left
    untouched; one with other bytes is replaced whole (a new file
    renamed over it, so a reader never sees part of one)."""
    script = script_bytes(file, (folder / file).read_bytes())
    target = script_path(folder, file)
    if target.is_file() and target.stat().st_size == len(script) \
            and target.read_bytes() == script:
        return script
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    try:
        tmp.write_bytes(script)
        os.replace(tmp, target)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return script

