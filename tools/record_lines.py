#!/usr/bin/env python3
"""Record every line of a game that would be spoken live, so a reader
needs no voice model (docs/plan.md Phase 52, item 13).

Usage:

    .venv/bin/python tools/record_lines.py GAME_FOLDER [--voice-dir DIR]
        [--bitrate KBPS] [--lang TAG] [--dry-run]

The lines are those the player speaks with spoken lines on
(player/src/render/spoken.ts, `spokenLine`): an item with text that is not
blank, no `audio.voice` of its own, and a voice: its speaker's in `voices`,
or the `narrator` when it has no speaker. A thought is spoken in its
speaker's voice. Items with an `audio.voice` the author recorded are left
alone.

Each line is made by the same `kinetic_voice` helper and engine the game
apps run (apps/voice/README.md), from a voice install folder (default: the
machine's, `~/Library/Application Support/Kinetic/Voice` on a Mac and
`%LOCALAPPDATA%\\Kinetic\\Voice` on Windows; installed first, as the apps
install it, when it is missing or incomplete), so a recorded line sounds as
the live one would. The helper seeds each line's randomness from its text,
so a line made twice is the same audio. Quit game apps that use the voice
folder first: the helper is not made for two users at once.

Each distinct (voice, text) becomes one mono Opus file in WebM at KBPS
(default 16), `lines/<xx>/<key>.webm`, written with the converter's pinned
ffmpeg, with its `.js` script beside it as every audio file has. Each file
is a track in `audio.tracks` whose id is `rec-` and 32 hex digits of the
key, and every item that speaks it gets `audio.voice` set to that track.
The key is the sha256 of the engine lock's id and engine settings, the
voice clip's sha256 and transcript, the line's text and the bitrate. That
makes the tracks the tool's own: a rerun records only lines whose key is
new, re-points items whose text or voice changed, and deletes the tracks
and the files under `lines/` that no item uses any more. A track whose id
or file does not have that shape is never touched.

An interrupted run loses at most about a minute: each file is written
whole as it finishes, the manifest is saved every 60 seconds, at the end
and on Ctrl-C, and a rerun picks up from the files on disk. manifest.json
keeps its own indentation; manifest.js is rewritten when the folder has one.
tools/validate_content.py then runs on the folder.

The lines are spoken in the manifest's `language` (default `en`), in the
engine's language for it (its primary subtag; `nb` and `nn` are `no`), as
the player speaks the base text live (player/src/render/linevoice.ts,
`engineLanguage`); a base language the engine does not speak is refused
(exit 2). An English base asks the helper for its default and keeps the
key without a language, so recordings made before languages existed stay
valid; any other base's key also holds the language.

--lang TAG records one translation's lines instead (docs/plan.md Phase 56,
item 6; docs/content-format.md, "Translations"), as the player would speak
them live with that language shown (player/src/render/linevoice.ts,
`lineVoice`): every item whose text `lang/<TAG>.json` translates, whose
speaker has a voice (or the narrator, for a line with no speaker), that has
no line of the author's own in the file's `voice.items`, and that would not
play the base recording under `keepOriginalVoice`. Each speaks the
translated text, in the engine's language for TAG (its primary subtag;
`nb` and `nn` are `no`); a language the engine does not speak is refused.
The files go under `lang/<TAG>/lines/`, the tracks into the file's
`voice.tracks` and the items into its `voice.items`, and `lang/<TAG>.json`
and `.js` are rewritten. The key also holds the language. Reruns, cleanup
and resuming work as for the manifest, within the language file; the
manifest is not touched.

--dry-run says how many lines would be recorded, with an estimate of the
time and the size, and touches nothing, starting no engine.

Exit status: 0 done, 1 a failure, 2 bad arguments, 130 interrupted.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import itertools
import json
import os
import platform
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
for _path in (REPO_ROOT / "converter", REPO_ROOT / "apps" / "voice",
              Path(__file__).resolve().parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))
import cast_voices  # noqa: E402
from cast_voices import Refusal  # noqa: E402
from kinetic_extract import audio_format, language_file, media_tools  # noqa: E402
from kinetic_extract.version import add_version_option  # noqa: E402
from kinetic_voice import install as voice_install  # noqa: E402
from kinetic_voice.engine import LANGUAGES, engine_language  # noqa: E402

DEFAULT_KBPS = 16
LINES_DIR = "lines"
TRACK_PREFIX = "rec-"
KEY_VERSION = 1
SAVE_EVERY = 60.0
PROGRESS_EVERY = 10.0
CLIP_FORMATS = ("wav", "flac", "mp3")  # what the helper's `voice` takes
#: Speech runs about 14 characters a second (docs/voice-reading.md).
CHARS_PER_SECOND = 14.0
#: Seconds of work per second of speech, measured on an M2 (Mac) and an
#: RTX 5090 (Windows): the dry run's estimate.
ESTIMATE_RTF = {"Darwin": 0.55, "Windows": 0.35}

TRACK_ID = re.compile(rf"{TRACK_PREFIX}[0-9a-f]{{32}}")
STRAY = re.compile(r"[0-9a-f]{64}\.webm(\.js)?|\..*\.tmp")


def lines_dir_of(tag: str | None) -> str:
    """Where the recorded lines go: `lines` for the manifest's, and
    `lang/<tag>/lines` for a language file's."""
    return LINES_DIR if tag is None else language_file.voice_lines_dir(tag)


def file_name(lines: str) -> re.Pattern[str]:
    return re.compile(rf"{re.escape(lines)}/([0-9a-f]{{2}})/([0-9a-f]{{64}})"
                      r"\.webm")


# --- the player's rule ---------------------------------------------------------

def line_voice(manifest: dict[str, Any],
               item: dict[str, Any]) -> tuple[str | None, str] | None:
    """(the speaker's name, None for the narrator; the text) when the
    player would speak this item live, not counting the item's own
    `audio.voice` (`plan` handles that), else None.

    Mirrors player/src/render/spoken.ts, `spokenLine`: text that is not
    blank, and a voice: the speaker's in `voices`, named exactly as the
    item gives it, or the `narrator` for an item with no speaker (absent or
    empty). tools/test_record_lines.py checks that spoken.ts still holds
    each clause.
    """
    text = item.get("text")
    if not isinstance(text, str) or text.strip() == "":
        return None
    speaker = item.get("speaker")
    if speaker is None or speaker == "":
        return (None, text) if isinstance(manifest.get("narrator"),
                                          dict) else None
    voices = manifest.get("voices")
    if isinstance(speaker, str) and isinstance(voices, dict) \
            and isinstance(voices.get(speaker), dict):
        return speaker, text
    return None


def own_track(track_id: str, track: Any, lines: str = LINES_DIR) -> bool:
    """Whether the recorder made this track: its id and its file (under
    `lines`) have the shapes it gives them, and the id names the file's
    key."""
    if not isinstance(track, dict) or not TRACK_ID.fullmatch(track_id):
        return False
    found = file_name(lines).fullmatch(str(track.get("file")))
    return found is not None and found.group(2).startswith(
        track_id[len(TRACK_PREFIX):])


def track_id(key: str) -> str:
    return TRACK_PREFIX + key[:32]


def file_of(key: str, lines: str = LINES_DIR) -> str:
    return f"{lines}/{key[:2]}/{key}.webm"


def translated_text(data: dict[str, Any], item_id: str) -> str | None:
    """The language file's text for an item, when it has one that is not
    blank (else the player shows the base text)."""
    items = data.get("items")
    entry = items.get(item_id) if isinstance(items, dict) else None
    text = entry.get("text") if isinstance(entry, dict) else None
    return text if isinstance(text, str) and text.strip() else None


def language_lines(manifest: dict[str, Any], data: dict[str, Any],
                   own: dict[str, Any]
                   ) -> list[tuple[int, str | None, str]]:
    """(item index, speaker or None for the narrator, translated text) of
    each item the player would speak live with the language file `data`
    shown, not counting the file's recordings the recorder made itself.

    Mirrors player/src/render/linevoice.ts, `lineVoice`, for translated
    text: the file's own recording wins, then the base recording under
    `keepOriginalVoice`, else the line is spoken live in its speaker's
    voice (or the narrator's) in the file's language."""
    voice = data.get("voice")
    recorded = voice.get("items") if isinstance(voice, dict) else None
    recorded = recorded if isinstance(recorded, dict) else {}
    keep = data.get("keepOriginalVoice") is True
    found = []
    for index, item in enumerate(manifest.get("items") or []):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        text = translated_text(data, item["id"])
        if text is None:
            continue
        mine = recorded.get(item["id"])
        if mine is not None and mine not in own:
            continue  # the author's own recording in this language
        audio = item.get("audio")
        if keep and isinstance(audio, dict) and "voice" in audio:
            continue  # the base recording plays under the translation
        spoken = line_voice(manifest, item)
        if spoken is None:
            continue
        found.append((index, spoken[0], text))
    return found


# --- planning ----------------------------------------------------------------

@dataclass
class Line:
    """One distinct (voice, text): the file every item that speaks it
    shares."""
    key: str
    voice: str | None  # the speaker's name, None for the narrator
    text: str
    items: list[int] = field(default_factory=list)


@dataclass
class Clip:
    name: str | None
    file: str
    fmt: str
    sha256: str
    transcript: str | None
    data: bytes


@dataclass
class Plan:
    lines: dict[str, Line]  # key -> line, in story order
    clips: dict[str | None, Clip]
    own: dict[str, dict[str, Any]]  # track id -> track, the recorder's own
    have: set[str]  # keys whose file is on disk
    kbps: int
    #: Where the files go (`lines_dir_of`), and the engine's language for
    #: the lines (None: the helper's default, English).
    folder: str = LINES_DIR
    lang: str | None = None

    @property
    def to_record(self) -> list[Line]:
        return [line for key, line in self.lines.items()
                if key not in self.have]

    @property
    def stale(self) -> list[str]:
        needed = {track_id(key) for key in self.have}
        return [tid for tid in self.own if tid not in needed]


def line_key(lock: dict[str, Any], clip: Clip, text: str, kbps: int,
             lang: str | None = None) -> str:
    """sha256 of everything that decides a line's recorded bytes: with
    `lang` (any language but English) the engine's language too."""
    fields = {"v": KEY_VERSION, "lock": lock["id"], "engine": lock["engine"],
              "clip": clip.sha256, "clipText": clip.transcript, "text": text,
              "kbps": kbps}
    if lang is not None:
        fields["lang"] = lang
    blob = json.dumps(fields, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def read_clip(game: Path, name: str | None, voice: dict[str, Any]) -> Clip:
    file = voice.get("file")
    label = "the narrator" if name is None else f"voice {name!r}"
    fmt = str(file).rsplit(".", 1)[-1].lower() if "." in str(file) else ""
    if fmt not in CLIP_FORMATS:
        raise Refusal(1, f"{label}: its reference clip {file} is {fmt or '?'}"
                         f"; the voice engine takes {', '.join(CLIP_FORMATS)}")
    path = game / str(file)
    if not path.is_file():
        raise Refusal(1, f"{label}: no reference clip at {path}")
    data = path.read_bytes()
    transcript = voice.get("text")
    return Clip(name, str(file), fmt, hashlib.sha256(data).hexdigest(),
                transcript if isinstance(transcript, str) else None, data)


def script_size(file: str, size: int) -> int:
    """The bytes of the script of a `size`-byte audio file."""
    return len(audio_format.script_bytes(file, b"")) + 4 * ((size + 2) // 3)


def on_disk(game: Path, key: str, lines: str = LINES_DIR) -> bool:
    path = game / file_of(key, lines)
    return path.is_file() and path.stat().st_size > 0


def manifest_lines(manifest: dict[str, Any], own: dict[str, Any]
                   ) -> list[tuple[int, str | None, str]]:
    """(item index, speaker or None for the narrator, text) of each item
    the player would speak live, not counting recordings the recorder
    made itself."""
    found = []
    for index, item in enumerate(manifest.get("items") or []):
        if not isinstance(item, dict):
            continue
        audio = item.get("audio")
        if isinstance(audio, dict) and "voice" in audio \
                and audio["voice"] not in own:
            continue  # the author's own recording always wins
        spoken = line_voice(manifest, item)
        if spoken is not None:
            found.append((index, spoken[0], spoken[1]))
    return found


def base_language(manifest: dict[str, Any]) -> str | None:
    """The engine's language for the manifest's own lines: None for an
    English base (the helper's default, and the key without a language,
    as before languages existed), else the engine's id for the manifest's
    `language`; Refusal(2) for one the engine does not speak."""
    tag = manifest.get("language")
    tag = tag if isinstance(tag, str) and tag else "en"
    lang = engine_language(tag)
    if lang is None:
        raise Refusal(2, f"the game's language is {tag!r}, which the voice "
                         f"engine does not speak; it speaks "
                         f"{', '.join(LANGUAGES)}")
    return None if lang == "en" else lang


def plan(game: Path, manifest: dict[str, Any], lock: dict[str, Any],
         kbps: int, doc: Document | None = None) -> Plan:
    """What to record for the manifest (in its base language,
    `base_language`), or with `doc` a language file (`LanguageFile`),
    against what is on disk."""
    folder = doc.folder if doc is not None else LINES_DIR
    lang = doc.lang if doc is not None else base_language(manifest)
    tracks = doc.tracks() if doc is not None else (
        (manifest.get("audio") or {}).get("tracks") or {})
    own = {tid: t for tid, t in tracks.items() if own_track(tid, t, folder)}
    wanted = manifest_lines(manifest, own) if doc is None \
        else language_lines(manifest, doc.data, own)
    clips: dict[str | None, Clip] = {}
    lines: dict[str, Line] = {}
    for index, name, text in wanted:
        if name not in clips:
            voice = manifest["narrator"] if name is None \
                else manifest["voices"][name]
            clips[name] = read_clip(game, name, voice)
        key = line_key(lock, clips[name], text, kbps, lang)
        line = lines.setdefault(key, Line(key, name, text))
        line.items.append(index)
    have = {key for key in lines if on_disk(game, key, folder)}
    return Plan(lines, clips, own, have, kbps, folder, lang)


# --- the voice helper ------------------------------------------------------------

class HelperError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class HelperClient:
    """The kinetic_voice helper over its JSON lines, one request at a
    time (apps/voice/README.md, "The protocol")."""

    def __init__(self, command: list[str], log: Path | None = None) -> None:
        self.log = log
        sink = log.open("ab") if log is not None else subprocess.DEVNULL
        self.proc = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=sink)
        if log is not None:
            sink.close()
        self._ids = itertools.count(1)

    def request(self, op: str,
                on_event: Callable[[dict[str, Any]], None] | None = None,
                **fields: Any) -> dict[str, Any]:
        rid = next(self._ids)
        message = json.dumps({"id": rid, "op": op, **fields},
                             separators=(",", ":")) + "\n"
        assert self.proc.stdin is not None and self.proc.stdout is not None
        try:
            self.proc.stdin.write(message.encode())
            self.proc.stdin.flush()
        except OSError:
            raise HelperError("helper-gone", self._gone()) from None
        while True:
            raw = self.proc.stdout.readline()
            if not raw:
                raise HelperError("helper-gone", self._gone())
            try:
                reply = json.loads(raw)
            except ValueError:
                continue
            if reply.get("event") is not None:
                if on_event is not None:
                    on_event(reply)
                continue
            if reply.get("id") != rid:
                continue
            if not reply.get("ok"):
                raise HelperError(str(reply.get("code")),
                                  str(reply.get("error")))
            return reply

    def _gone(self) -> str:
        where = f" (see {self.log})" if self.log is not None else ""
        return f"the voice helper stopped{where}"

    def register(self, data: bytes, fmt: str, text: str | None) -> str:
        fields: dict[str, Any] = {
            "voice": base64.b64encode(data).decode(), "format": fmt}
        if text is not None:
            fields["text"] = text
        return self.request("voice", **fields)["voiceId"]

    def speak(self, voice_id: str, text: str,
              lang: str | None = None) -> tuple[bytes, float, float, bool]:
        """(WAV bytes, seconds of speech, seconds the engine took, whether
        the helper's own cache had the line) of one line, in the engine's
        language `lang` (None: the helper's default, English)."""
        fields: dict[str, Any] = {"voiceId": voice_id, "text": text}
        if lang is not None:
            fields["lang"] = lang
        reply = self.request("speak", **fields)
        return (base64.b64decode(reply["wav"]), float(reply["seconds"]),
                float(reply.get("genSeconds", 0)),
                bool(reply.get("cached", False)))

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.request("quit")
        except (HelperError, OSError):
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()


# --- the voice install ---------------------------------------------------------------

def default_voice_dir() -> Path:
    if platform.system() == "Windows":
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) / "Kinetic" / "Voice" if base else Path.home() / (
            "AppData/Local/Kinetic/Voice")
    return Path.home() / "Library" / "Application Support" / "Kinetic" / (
        "Voice")


def load_lock(path: Path | None) -> dict[str, Any]:
    lock_path = path or voice_install.default_lock_path()
    try:
        return json.loads(lock_path.read_text("utf-8"))
    except OSError:
        raise Refusal(1, f"no voice lock for this machine ({lock_path}); "
                         "spoken lines run on Apple silicon Macs and "
                         "Windows PCs with an NVIDIA card") from None
    except ValueError as err:
        raise Refusal(1, f"{lock_path} is not valid JSON: {err}") from None


def write_helper(voice_dir: Path, lock_path: Path) -> Path:
    """The helper's files in `<voice>/helper/`, as the apps write them
    (those already there and identical are left alone)."""
    source = REPO_ROOT / "apps" / "voice" / "kinetic_voice"
    target = voice_dir / "helper"
    files = [(p, target / "kinetic_voice" / p.name)
             for p in sorted(source.glob("*.py"))]
    files.append((lock_path, target / lock_path.name))
    for src, dest in files:
        data = src.read_bytes()
        if not dest.is_file() or dest.read_bytes() != data:
            dest.parent.mkdir(parents=True, exist_ok=True)
            cast_voices.write_atomic(dest, data)
    return target


class Progress:
    """Download progress on stderr, a line every few seconds."""

    def __init__(self, say: Callable[[str], None]) -> None:
        self.say = say
        self.last = 0.0
        self.phase = ""

    def __call__(self, event: dict[str, Any]) -> None:
        if event.get("event") == "log":
            if event.get("message") in ("installing packages",
                                        "unpacking python"):
                self.say(str(event["message"]))
            return
        if event.get("event") != "progress":
            return
        now = time.monotonic()
        phase = event.get("phase", "")
        done, total = event.get("done", 0), event.get("total", 0)
        if phase != self.phase or now - self.last >= 5 \
                or (total and done >= total):
            self.phase, self.last = phase, now
            share = f" ({100 * done // total}%)" if total else ""
            self.say(f"downloading {phase}: {done / 1e9:.2f} of "
                     f"{total / 1e9:.2f} GB{share} {event.get('file', '')}")


def start_engine(voice_dir: Path, lock_path: Path, lock: dict[str, Any],
                 say: Callable[[str], None]) -> HelperClient:
    """The helper running on `voice_dir`, with the voice installed: the
    private Python unpacked and the helper written (as the apps do), then
    the helper's own install."""
    voice_dir.mkdir(parents=True, exist_ok=True)
    helper = write_helper(voice_dir, lock_path)
    progress = Progress(say)
    installer = voice_install.Installer(voice_dir, voice_install.Lock(lock),
                                        progress)
    cancel = threading.Event()
    try:
        if not installer.python_ready():
            say("installing the voice engine's Python")
            installer.install_python(cancel)
    except voice_install.InstallError as err:
        raise Refusal(1, str(err)) from None
    command = [str(voice_install.python_executable(voice_dir)), "-I", "-B",
               str(helper / "kinetic_voice" / "__main__.py"), "--root",
               str(voice_dir), "--lock", str(helper / lock_path.name)]
    client = HelperClient(command, voice_dir / "record-lines.log")
    try:
        status = client.request("status")
        if not status["installed"]:
            gigabytes = status["remainingBytes"] / 1e9
            say(f"installing the voice model: {gigabytes:.2f} GB to "
                "download")
            client.request("install", on_event=progress)
    except HelperError as err:
        client.close()
        raise Refusal(1, f"the voice engine cannot be installed: {err}"
                      ) from None
    return client


# --- encoding -------------------------------------------------------------------------

def encode_opus(wav: bytes, path: Path, kbps: int) -> None:
    """`wav` as mono Opus in WebM at `kbps`, written to `path` whole (a
    temporary file renamed over it), with the pinned ffmpeg."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    cmd = [*media_tools.ffmpeg_cmd(), "-y", *media_tools.FFMPEG_DECODE,
           "-f", "wav", "-i", "pipe:0", "-map", "0:a:0", "-ac", "1",
           "-c:a", "libopus", "-b:a", f"{kbps}k",
           *media_tools.FFMPEG_ENCODE, "-f", "webm", str(tmp)]
    try:
        proc = subprocess.run(cmd, input=wav, capture_output=True,
                              check=False)
        if proc.returncode != 0:
            raise Refusal(1, "ffmpeg cannot encode a line: "
                             + proc.stderr.decode(errors="replace").strip())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def file_seconds(path: Path) -> float:
    """The length of an audio file, from ffprobe."""
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-show_entries", "format=duration",
         "-of", "json", str(path)], capture_output=True, text=True,
        check=False)
    try:
        return float(json.loads(proc.stdout)["format"]["duration"])
    except (ValueError, KeyError, TypeError):
        raise Refusal(1, f"ffprobe cannot read {path}: "
                         f"{proc.stderr.strip()}") from None


def finish_file(game: Path, key: str, lines: str = LINES_DIR) -> None:
    """Its script beside a file, if it has none or a wrong one."""
    file = file_of(key, lines)
    script = audio_format.script_path(game, file)
    size = (game / file).stat().st_size
    if not script.is_file() or script.stat().st_size != script_size(file,
                                                                    size):
        audio_format.write_script(game, file)


# --- the manifest ------------------------------------------------------------------------

class Document:
    """Where the recorded lines are written: the manifest (`Manifest`) or
    a language file (`LanguageFile`). Items are named by their index in
    the manifest's `items`."""

    #: The folder the files go in (`lines_dir_of`).
    folder = LINES_DIR
    #: The engine's language for a language file's lines; None: the
    #: manifest's.
    lang: str | None = None
    data: dict[str, Any]
    dirty: bool

    def tracks(self, create: bool = False) -> dict[str, Any]:
        raise NotImplementedError

    def voices(self) -> list[tuple[int, Any]]:
        """(item index, the track id it speaks, or None) per item."""
        raise NotImplementedError

    def add_track(self, key: str, seconds: float) -> None:
        self.tracks(create=True)[track_id(key)] = {
            "file": file_of(key, self.folder), "durationSeconds": seconds}
        self.dirty = True

    def drop_track(self, tid: str) -> None:
        self.tracks().pop(tid, None)
        self.dirty = True

    def set_voice(self, index: int, tid: str) -> None:
        raise NotImplementedError

    def clear_voice(self, index: int) -> None:
        raise NotImplementedError

    def tidy(self) -> None:
        raise NotImplementedError

    def save(self) -> None:
        raise NotImplementedError


class Manifest(Document):
    """manifest.json (and manifest.js) kept in the file's own style,
    rewritten whole as the run goes."""

    def __init__(self, game: Path, text: str, data: dict[str, Any]) -> None:
        self.game, self.data = game, data
        self.style = cast_voices._Style(text)
        self.newline = text.endswith("\n")
        self.dirty = False
        self.items: list[dict[str, Any]] = data.get("items") or []

    def voices(self) -> list[tuple[int, Any]]:
        out = []
        for index, item in enumerate(self.items):
            audio = item.get("audio") if isinstance(item, dict) else None
            out.append((index, audio.get("voice")
                        if isinstance(audio, dict) else None))
        return out

    def tracks(self, create: bool = False) -> dict[str, Any]:
        audio = self.data.get("audio")
        if not isinstance(audio, dict):
            if not create:
                return {}
            audio = {}
            # Before the items, where a reader looks for it.
            items = self.data.pop("items", None)
            self.data["audio"] = audio
            if items is not None:
                self.data["items"] = items
        if create:
            return audio.setdefault("tracks", {})
        return audio.get("tracks") or {}

    def set_voice(self, index: int, tid: str) -> None:
        audio = self.items[index].setdefault("audio", {})
        if audio.get("voice") != tid:
            audio["voice"] = tid
            self.dirty = True

    def clear_voice(self, index: int) -> None:
        item = self.items[index]
        audio = item.get("audio")
        if isinstance(audio, dict) and "voice" in audio:
            del audio["voice"]
            if not audio:
                del item["audio"]
            self.dirty = True

    def tidy(self) -> None:
        """No empty `tracks` or `audio` left behind."""
        audio = self.data.get("audio")
        if isinstance(audio, dict) and audio.get("tracks") == {}:
            del audio["tracks"]
            self.dirty = True
        if audio == {}:
            del self.data["audio"]
            self.dirty = True

    def save(self) -> None:
        if not self.dirty:
            return
        text = self.style.dumps(self.data, 0) + ("\n" if self.newline
                                                 else "")
        cast_voices.write_atomic(self.game / cast_voices.MANIFEST_NAME,
                                 text.encode("utf-8"))
        if (self.game / cast_voices.SHIM_NAME).exists():
            cast_voices.write_atomic(
                self.game / cast_voices.SHIM_NAME,
                f"{cast_voices.SHIM_PREFIX}{text.strip()};\n".encode("utf-8"))
        self.dirty = False


class LanguageFile(Document):
    """A language file, `lang/<tag>.json`, whose `voice` block takes the
    recorded lines: `voice.tracks` and `voice.items` (item id -> track).
    Saved with its script by `language_file.write_language_file`."""

    def __init__(self, game: Path, tag: str, lang: str, data: dict[str, Any],
                 items: list[Any]) -> None:
        self.game, self.tag, self.lang, self.data = game, tag, lang, data
        self.folder = lines_dir_of(tag)
        self.dirty = False
        self.ids = [item.get("id") if isinstance(item, dict) else None
                    for item in items]

    def _voice(self, create: bool) -> dict[str, Any]:
        voice = self.data.get("voice")
        if not isinstance(voice, dict):
            if not create:
                return {}
            voice = self.data["voice"] = {}
        return voice

    def tracks(self, create: bool = False) -> dict[str, Any]:
        voice = self._voice(create)
        if create:
            return voice.setdefault("tracks", {})
        tracks = voice.get("tracks")
        return tracks if isinstance(tracks, dict) else {}

    def _items(self, create: bool) -> dict[str, Any]:
        voice = self._voice(create)
        if create:
            return voice.setdefault("items", {})
        items = voice.get("items")
        return items if isinstance(items, dict) else {}

    def voices(self) -> list[tuple[int, Any]]:
        items = self._items(False)
        return [(index, items.get(item_id) if isinstance(item_id, str)
                 else None) for index, item_id in enumerate(self.ids)]

    def set_voice(self, index: int, tid: str) -> None:
        items = self._items(True)
        if items.get(self.ids[index]) != tid:
            items[self.ids[index]] = tid
            self.dirty = True

    def clear_voice(self, index: int) -> None:
        items = self._items(False)
        if self.ids[index] in items:
            del items[self.ids[index]]
            self.dirty = True

    def tidy(self) -> None:
        """No empty `tracks`, `items` or `voice` left behind."""
        voice = self.data.get("voice")
        if not isinstance(voice, dict):
            return
        for part in ("tracks", "items"):
            if voice.get(part) == {}:
                del voice[part]
                self.dirty = True
        if voice == {}:
            del self.data["voice"]
            self.dirty = True

    def save(self) -> None:
        if not self.dirty:
            return
        language_file.write_language_file(self.game, self.data)
        self.dirty = False


def read_language(game: Path, manifest: dict[str, Any],
                  tag: str) -> tuple[str, dict[str, Any]]:
    """(the engine's language, the language file's object) for `--lang
    TAG`; Refusal(2) for a tag the game does not list or the engine does
    not speak."""
    listed = manifest.get("languages")
    listed = listed if isinstance(listed, list) else []
    if tag not in listed:
        names = ", ".join(str(t) for t in listed) or "none"
        raise Refusal(2, f"the game has no language {tag!r}: its manifest's "
                         f"languages are {names}")
    lang = engine_language(tag)
    if lang is None:
        raise Refusal(2, f"the voice engine does not speak {tag!r}; it "
                         f"speaks {', '.join(LANGUAGES)}")
    path = game / language_file.json_path(tag)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError:
        raise Refusal(1, f"no language file {path}") from None
    except ValueError as err:
        raise Refusal(1, f"{path} is not valid JSON: {err}") from None
    if not isinstance(data, dict) or data.get("language") != tag:
        raise Refusal(1, f"{path} is not the language file of {tag!r}")
    return lang, data


def apply_plan(game: Path, manifest: Document, planned: Plan) -> int:
    """Bring manifest and folder in step with what is on disk, before any
    line is recorded: items whose line changed lose their old voice at
    once (never a wrong one), files the run left unfinished get their
    tracks, and the recorder's tracks and files that no item uses any more
    go. Returns the number of audio files deleted."""
    wanted = {i: key for key, line in planned.lines.items()
              for i in line.items}
    for index, voice in manifest.voices():
        if isinstance(voice, str) and voice in planned.own:
            key = wanted.get(index)
            if key is None or key not in planned.have \
                    or track_id(key) != voice:
                manifest.clear_voice(index)
    tracks = manifest.tracks()
    for key in planned.have:
        finish_file(game, key, planned.folder)
        tid = track_id(key)
        if tid not in tracks:
            manifest.add_track(key, round(file_seconds(
                game / file_of(key, planned.folder)), 3))
        for index in planned.lines[key].items:
            manifest.set_voice(index, tid)
    gone = [planned.own[tid]["file"] for tid in planned.stale]
    for tid in planned.stale:
        manifest.drop_track(tid)
    manifest.tidy()
    manifest.save()
    # The files go only after the manifest no longer names them.
    removed = 0
    for file in gone:
        removed += _unlink(game / file)
    folder = game / planned.folder
    if folder.is_dir():
        for path in sorted(folder.glob("*/*")):
            if not STRAY.fullmatch(path.name):
                continue
            if path.name.startswith(".") or path.name[:64] not in \
                    planned.have:
                removed += _unlink(path)
        for bucket in folder.glob("*"):
            _rmdir(bucket)
        _rmdir(folder)
    return removed


def _unlink(path: Path) -> int:
    """Delete an audio file and its script; 1 when a .webm went."""
    count = 1 if path.suffix == ".webm" and path.exists() else 0
    path.unlink(missing_ok=True)
    if path.suffix == ".webm":
        audio_format.script_path(path.parent, path.name).unlink(
            missing_ok=True)
    return count


def _rmdir(path: Path) -> None:
    try:
        path.rmdir()
    except OSError:
        pass


# --- recording ---------------------------------------------------------------------------

@dataclass
class Stats:
    recorded: int = 0
    speech_seconds: float = 0.0
    seconds: float = 0.0
    generated: int = 0  # lines the engine made, not the helper's cache
    generated_speech: float = 0.0
    generated_seconds: float = 0.0
    load_seconds: float = 0.0


def clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds >= 3600:
        return f"{seconds // 3600} h {seconds % 3600 // 60:02d} min"
    if seconds >= 60:
        return f"{seconds // 60} min {seconds % 60:02d} s"
    return f"{seconds} s"


def record_all(game: Path, manifest: Document, planned: Plan,
               client: HelperClient, say: Callable[[str], None],
               encode: Callable[[bytes, Path, int], None] | None = None,
               ) -> Stats:
    """Speak, encode and place every line still to record; the manifest is
    saved every SAVE_EVERY seconds, and by the caller at the end and on
    Ctrl-C."""
    stats = Stats()
    todo = planned.to_record
    if not todo:
        return stats
    started = time.monotonic()
    say(f"loading the engine and {len({l.voice for l in todo})} voice(s)")
    voice_ids: dict[str | None, str] = {}
    for line in todo:
        if line.voice not in voice_ids:
            clip = planned.clips[line.voice]
            voice_ids[line.voice] = client.register(clip.data, clip.fmt,
                                                    clip.transcript)
    stats.load_seconds = time.monotonic() - started
    say(f"ready in {clock(stats.load_seconds)}: recording {len(todo)} "
        "line(s)")
    chars_total = sum(len(line.text) for line in todo)
    chars_done = 0
    begun = last_save = last_say = time.monotonic()
    for number, line in enumerate(todo, 1):
        wav, seconds, took, cached = client.speak(voice_ids[line.voice],
                                                  line.text, planned.lang)
        if not cached:
            stats.generated += 1
            stats.generated_speech += seconds
            stats.generated_seconds += took
        encode_opus_now = encode or encode_opus
        encode_opus_now(wav, game / file_of(line.key, planned.folder),
                        planned.kbps)
        finish_file(game, line.key, planned.folder)
        manifest.add_track(line.key, round(seconds, 3))
        for index in line.items:
            manifest.set_voice(index, track_id(line.key))
        stats.recorded += 1
        stats.speech_seconds += seconds
        chars_done += len(line.text)
        now = time.monotonic()
        stats.seconds = now - begun
        if now - last_save >= SAVE_EVERY:
            manifest.save()
            last_save = now
        if now - last_say >= PROGRESS_EVERY:
            last_say = now
            left = stats.seconds * (chars_total - chars_done) / chars_done
            say(f"{number} of {len(todo)} lines, "
                f"{clock(stats.speech_seconds)} of speech, "
                f"{clock(stats.seconds)} elapsed, about {clock(left)} left")
    return stats


# --- the command ----------------------------------------------------------------------------

def megabytes(size: float) -> str:
    return f"{size / 1e6:.1f} MB" if size < 1e9 else f"{size / 1e9:.2f} GB"


def estimate(planned: Plan) -> tuple[float, float, float]:
    """(seconds of speech, seconds of work, bytes with scripts) for the
    lines still to record."""
    chars = sum(len(line.text) for line in planned.to_record)
    speech = chars / CHARS_PER_SECOND
    work = speech * ESTIMATE_RTF.get(platform.system(), 0.55)
    audio = speech * planned.kbps * 1000 / 8 * 1.03
    return speech, work, audio * 4 / 3


def owned_bytes(game: Path, manifest: Document) -> int:
    total = 0
    for tid, track in manifest.tracks().items():
        if own_track(tid, track, manifest.folder):
            path = game / track["file"]
            script = audio_format.script_path(game, track["file"])
            for each in (path, script):
                if each.is_file():
                    total += each.stat().st_size
    return total


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="record_lines.py", description=__doc__.split("\n\n")[0],
        epilog="The tool's docstring (tools/record_lines.py) has the whole "
               "story.")
    add_version_option(parser)
    parser.add_argument("game", help="the game folder (holds manifest.json)")
    parser.add_argument("--voice-dir", metavar="DIR", type=Path,
                        help="the voice install folder (default: the "
                             "machine's, which is installed if missing)")
    parser.add_argument("--bitrate", metavar="KBPS", type=int,
                        default=DEFAULT_KBPS,
                        help=f"Opus bitrate (default {DEFAULT_KBPS})")
    parser.add_argument("--lang", metavar="TAG",
                        help="record the lines of the language file "
                             "lang/TAG.json in that language, into it")
    parser.add_argument("--dry-run", action="store_true",
                        help="say how many lines would be recorded, with "
                             "an estimate; touch nothing")
    parser.add_argument("--lock", metavar="FILE", type=Path,
                        help="a voice lock file (default: this machine's "
                             "apps/voice/lock-<platform>.json)")
    return parser


def main(argv: list[str] | None = None,
         helper_command: list[str] | None = None) -> int:
    """`helper_command` is a test seam: it starts the helper instead of
    the voice install."""
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as exc:
        return exc.code if isinstance(exc.code, int) else 2
    if not 6 <= args.bitrate <= 256:
        print("record_lines: --bitrate is between 6 and 256 kb/s",
              file=sys.stderr)
        return 2
    try:
        return run(args, argv, helper_command)
    except Refusal as exc:
        print(f"record_lines: {exc}", file=sys.stderr)
        return exc.status


def run(args: argparse.Namespace, argv: list[str],
        helper_command: list[str] | None) -> int:
    def say(message: str) -> None:
        print(f"record_lines: {message}", file=sys.stderr, flush=True)

    game = Path(args.game)
    text, data = cast_voices.read_game(game)
    lock_path = args.lock or voice_install.default_lock_path()
    lock = load_lock(lock_path)
    if args.dry_run is False:
        cast_voices._need_validator(argv)
    manifest: Document
    if args.lang is None:
        manifest = Manifest(game, text, data)
        planned = plan(game, data, lock, args.bitrate)
        where = ""
    else:
        lang, lang_data = read_language(game, data, args.lang)
        manifest = LanguageFile(game, args.lang, lang, lang_data,
                                data.get("items") or [])
        planned = plan(game, data, lock, args.bitrate, manifest)
        where = f" in {args.lang}"
    speaks = sum(len(line.items) for line in planned.lines.values())
    todo = planned.to_record
    if not planned.lines and not planned.own:
        print(f"record_lines: no item would be spoken{where}: the game has "
              "no voices (or narrator) for its lines"
              + (", or the language file translates none of them, or "
                 "records them all itself" if where else ""))
        return 0
    if args.dry_run:
        speech, work, size = estimate(planned)
        print(f"{speaks} items speak live{where}, {len(planned.lines)} "
              "distinct lines")
        print(f"{len(todo)} lines to record, {len(planned.have)} recorded "
              f"already, {len(planned.stale)} recorded lines to remove")
        print(f"estimate: about {clock(speech)} of speech, {clock(work)} "
              f"of work, {megabytes(size)} added")
        return 0
    check_ffmpeg()
    reused = len(planned.have)
    removed = apply_plan(game, manifest, planned)
    stats = Stats()
    client: HelperClient | None = None
    try:
        if todo:
            if helper_command is not None:
                client = HelperClient(helper_command)
            else:
                client = start_engine(
                    args.voice_dir or default_voice_dir(), lock_path, lock,
                    say)
            stats = record_all(game, manifest, planned, client, say)
    except KeyboardInterrupt:
        manifest.save()
        say("interrupted: the lines recorded so far are saved; run it "
            "again to continue")
        return 130
    except HelperError as err:
        manifest.save()
        raise Refusal(1, f"the voice engine failed: {err}") from None
    finally:
        manifest.save()
        if client is not None:
            client.close()
    factor = ""
    if stats.generated:
        factor = (f"; the engine ran at "
                  f"{stats.generated_seconds / stats.generated_speech:.2f}x "
                  f"real time ({clock(stats.generated_seconds)} for "
                  f"{clock(stats.generated_speech)} of speech)")
    if stats.recorded > stats.generated:
        factor += (f"; {stats.recorded - stats.generated} lines came from "
                   "the voice folder's cache")
    print(f"{stats.recorded} recorded, {reused} reused, {removed} removed; "
          f"{megabytes(owned_bytes(game, manifest))} of recorded lines in "
          f"the folder (scripts included){factor}")
    import validate_content

    if validate_content.main([str(game)]) != 0:
        print(f"record_lines: {game} has validator problems (above)",
              file=sys.stderr)
        return 1
    return 0


def check_ffmpeg() -> None:
    cast_voices.check_ffmpeg()


if __name__ == "__main__":
    sys.exit(main())
