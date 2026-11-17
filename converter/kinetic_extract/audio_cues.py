"""Ren'Py audio cues -> per-item Kinetic audio (docs/plan.md Phase 47,
item 8; docs/content-format.md "Audio").

The timeline hands every ``audio`` event and every emitted item to a
``CueWalker``. The walker resolves the statement's names and files the
way Ren'Py does, keeps the channels' state, and gives each item an
``audio`` dict in the content format's item shape (``music``,
``ambience``, ``fadeMs``, ``sfx``, ``voice``) whose values are track ids.
The tracks themselves (``AudioTrack``: the source file, where a play
starts and loops, the volume, whether music loops) are what the shipping
step (kinetic_extract.audio_ship, item 9) ships, measures and writes as
``audio.tracks``, moving the cues into the manifest items.

Mapping (Ren'Py 8.3 rules, read from its renpy/audio and renpy/common):

- the ``music`` channel is the item's music; ``stop music`` is null;
- a looping play on any other channel puts that channel's loop in the
  ambience set and a stop takes it out. A play stops what its channel
  was playing, so a one-shot on a looping channel ends the loop;
- a play that does not loop is a one-shot whose ``channel`` is the Ren'Py
  channel, except on ``audio``: each sound there gets a fresh
  sub-channel, so its one-shots overlap and ``stop audio`` stops nothing;
- ``voice`` (and a play on the voice channel) is the voice of the next
  item that carries a line;
- loop defaults: ``music`` loops, ``sound``, ``voice`` and ``audio`` do
  not, a registered channel loops unless registered with ``loop=False``;
- each cue attaches to the next item emitted, with the whole ambience
  set when it changed. ``fadein``/``fadeout`` become ``fadeMs`` (the
  longest given, for the item's music and ambience changes).

Menus: a cue read before a menu reaches the first item of every route,
each route starts from the state before the menu, and a cue after a
route's last item stays on that item. After the menu the last route's
state goes on; when the routes left different ambience sets, the next
ambience change says so.
"""

from __future__ import annotations

import os
import re
from collections.abc import Container
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .audio_statements import (EXPRESSION, PLAYLIST, UNPARSEABLE,
                               AudioChannel, AudioRef, AudioStatement)
from .parser import Event, FileParse, Report
from .rpa import AssetArchives, RpaArchive, extract_cached

if TYPE_CHECKING:
    from .timeline import ItemRecord

__all__ = ["AudioFiles", "AudioSource", "AudioTrack", "CueWalker",
           "carry_dropped_audio", "drop_tracks", "fresh_track_id",
           "merge_audio", "rename_tracks", "track_ids"]

# renpy/common/00audio.rpy `_scan_audio_directory`: the files under
# game/audio/ that get an automatic `audio.<name>`.
AUDIO_NAME_EXTS = frozenset({".wav", ".mp2", ".mp3", ".ogg", ".opus",
                             ".flac"})
# From this Ren'Py on, `register_channel(loop=None)` no longer loops: the
# absent default became a sentinel and an explicit None reads as False.
NONE_STOPS_LOOPING = (8, 4)
_VERSION_RE = re.compile(r"""^version\s*=\s*['"](\d+)\.(\d+)""", re.M)
_SPEC_RE = re.compile(r"<(.*)>(.*)")  # Ren'Py's own split_filename rule
_ID_BAD_RE = re.compile(r"[^A-Za-z0-9_-]+")

_BUILTIN_CHANNELS = {
    "music": AudioChannel("music", "music", True),
    "sound": AudioChannel("sound", "sfx", False),
    "voice": AudioChannel("voice", "voice", False),
    "audio": AudioChannel("audio", "sfx", False),
    "movie": AudioChannel("movie", "music", False, movie=True),
}
_KEY_ORDER = ("music", "ambience", "fadeMs", "sfx", "voice", "videoSound")

MISSING = "audio file {file!r} missing: cue dropped"
MISSING_VOICE = "voice file {file!r} missing: cue dropped"
AFTER_LAST = "audio cue after the last item: not converted"
QUEUED = "queued after another track: not converted (the first plays)"
SILENCE = "<silence> not converted"
TO_SPEC = "<to N> not converted: the track plays to its end"
UNDEFINED = "audio name {name!r} is not defined: not converted"
UNKNOWN_CHANNEL = ("audio channel {channel!r} is not registered in the "
                   "scripts: not converted")
MOVIE = "the movie channel plays video: not converted"
VOICE_MENU = "voice before a menu: not converted"
VOICE_DROPPED = "voice dropped with its line"
VOICE_EXTEND = ("voice before an extend line: not converted (the line "
                "joins the item before it, which keeps its own voice)")
VOICE_NO_LINE = "voice with no line after it in its route: not converted"
EMPTY_ROUTE = "audio cue in a choice block with no item: not converted"
AMBIGUOUS = ("ambience after a menu whose routes leave different sets: "
             "computed from the last route's")


@dataclass(frozen=True)
class AudioSource:
    """Where an audio file's bytes are: a loose file under game/
    (``path``) or an archive member (``archive`` and ``member``).
    ``asset`` is the ledger's display name and ``source_ref`` the media
    source (docs/extracting.md, "Build ledger")."""

    asset: str
    source_ref: dict[str, str]
    path: Path | None = None
    archive: RpaArchive | None = None
    member: str | None = None


@dataclass
class AudioTrack:
    """One track the cues name: one source file played one way.

    Several tracks may share a file (another start, loop point, volume,
    or music that does not loop). The shipping step (audio_ship) ships
    ``local_path()`` and writes ``fields()`` with the measured
    duration."""

    id: str
    source: AudioSource
    start_seconds: float = 0.0
    loop_start_seconds: float | None = None
    volume: float = 1.0
    loop: bool = True

    @property
    def asset(self) -> str:
        return self.source.asset

    @property
    def source_ref(self) -> dict[str, str]:
        return self.source.source_ref

    def local_path(self) -> Path:
        """The file to ship; an archive member is extracted on first
        need into the shared extraction cache."""
        if self.source.path is not None:
            return self.source.path
        assert self.source.archive is not None and self.source.member
        return extract_cached(self.source.archive, self.source.member)

    def fields(self) -> dict[str, Any]:
        """The track's content-format fields that differ from their
        defaults (``file`` and ``durationSeconds`` come with shipping)."""
        out: dict[str, Any] = {}
        if self.start_seconds:
            out["startSeconds"] = self.start_seconds
        if self.loop_start_seconds is not None:
            out["loopStartSeconds"] = self.loop_start_seconds
        if self.volume != 1.0:
            out["volume"] = self.volume
        if not self.loop:
            out["loop"] = False
        return out


class AudioFiles:
    """The game's audio files as Ren'Py's loader sees them: loose under
    game/, then in the ``.rpa`` archives, each name tried as given and
    then under game/audio/ (``renpy.loader.load(name, directory=
    "audio")``)."""

    def __init__(self, game_dir: Path,
                 archives: AssetArchives | None = None) -> None:
        self.game_dir = Path(game_dir)
        self.archives = archives
        self._names: dict[str, str] | None = None

    def find(self, name: str) -> AudioSource | None:
        rel = re.sub(r"/+", "/", name).lstrip("/")
        for cand in (rel, f"audio/{rel}"):
            loose = self.game_dir / cand
            if loose.is_file():
                ref = f"game/{cand}"
                return AudioSource(ref, {"path": ref}, path=loose)
            hit = self.archives.member(cand) if self.archives else None
            if hit is not None:
                arc, key = hit
                archive = f"game/{arc.path.name}"
                return AudioSource(f"{archive}!{key}",
                                   {"archive": archive, "member": key},
                                   archive=arc, member=key)
        return None

    def names(self) -> dict[str, str]:
        """The automatic ``audio.`` names: each file under game/audio/
        (any depth, loose or archived) with an audio extension is named
        by its base name lowercased; the first path in sorted order wins
        a clash (renpy/common/00audio.rpy)."""
        if self._names is None:
            found: set[str] = set()
            for dirpath, _dirs, files in os.walk(self.game_dir / "audio"):
                found.update(
                    (Path(dirpath) / f).relative_to(self.game_dir).as_posix()
                    for f in files)
            if self.archives is not None:
                found.update(k for k in self.archives.keys()
                             if k.startswith("audio/"))
            names: dict[str, str] = {}
            for rel in sorted(found):
                base, ext = os.path.splitext(os.path.basename(rel))
                if ext.lower() in AUDIO_NAME_EXTS:
                    names.setdefault(base.lower(), rel)
            self._names = names
        return self._names

    def renpy_version(self) -> tuple[int, int] | None:
        """(major, minor) of the Ren'Py shipped beside game/, if any."""
        path = self.game_dir.parent / "renpy" / "vc_version.py"
        try:
            m = _VERSION_RE.search(path.read_text("utf-8", "replace"))
        except OSError:
            return None
        return (int(m.group(1)), int(m.group(2))) if m else None


@dataclass
class _Group:
    """The cues read since the last item, waiting for the next one."""

    music: str | None = None
    music_set: bool = False
    ambience_set: bool = False
    fades: list[float] = field(default_factory=list)
    sfx: list[dict[str, str]] = field(default_factory=list)
    channels: set[str] = field(default_factory=set)  # named a track here
    origins: list[tuple[FileParse, str, str]] = field(default_factory=list)

    def render(self, ambience: dict[str, str]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.music_set:
            out["music"] = self.music
        if self.ambience_set:
            out["ambience"] = list(dict.fromkeys(ambience.values()))
        if self.fades and (self.music_set or self.ambience_set):
            out["fadeMs"] = round(max(self.fades) * 1000)
        if self.sfx:
            out["sfx"] = [dict(entry) for entry in self.sfx]
        return out

    def copy(self) -> _Group:
        return replace(self, fades=list(self.fades),
                       sfx=[dict(e) for e in self.sfx],
                       channels=set(self.channels),
                       origins=list(self.origins))


def merge_audio(earlier: dict[str, Any] | None,
                later: dict[str, Any] | None) -> dict[str, Any] | None:
    """Two items' audio as one: the later music, ambience and voice win,
    one-shots add up, the longest fade stays."""
    if not earlier or not later:
        return dict(earlier or later) if (earlier or later) else None
    out = dict(earlier)
    for key in ("music", "ambience", "voice"):
        if key in later:
            out[key] = later[key]
    if "fadeMs" in later:
        out["fadeMs"] = max(later["fadeMs"], earlier.get("fadeMs", 0))
    if "sfx" in later:
        out["sfx"] = earlier.get("sfx", []) + later["sfx"]
    return {key: out[key] for key in _KEY_ORDER if key in out}


def rename_tracks(audio: dict[str, Any],
                  new_id: dict[str, str]) -> dict[str, Any]:
    """An item's audio with every track id mapped through ``new_id``."""
    out = dict(audio)
    for key in ("music", "voice"):
        if out.get(key) is not None:
            out[key] = new_id[out[key]]
    if "ambience" in out:
        out["ambience"] = [new_id[t] for t in out["ambience"]]
    if "sfx" in out:
        out["sfx"] = [{**e, "track": new_id[e["track"]]} for e in out["sfx"]]
    return out


def track_ids(audio: dict[str, Any]) -> list[str]:
    """Every track id an item's audio names, in field order."""
    ids = [audio[key] for key in ("music", "voice")
           if audio.get(key) is not None]
    ids += audio.get("ambience", [])
    ids += [entry["track"] for entry in audio.get("sfx", [])]
    if "videoSound" in audio:
        ids.append(audio["videoSound"]["track"])
    return ids


def drop_tracks(audio: dict[str, Any],
                gone: set[str]) -> dict[str, Any] | None:
    """An item's audio without the cues of the tracks in ``gone``, as a
    missing file's cue is dropped: their music change, voice and
    one-shots go, and they leave the ambience set (the rest of the set
    stays). A fade with no change left goes too; None when nothing is
    left."""
    out = {key: value for key, value in audio.items()
           if not (key in ("music", "voice") and value in gone)}
    if "ambience" in out:
        out["ambience"] = [t for t in out["ambience"] if t not in gone]
    if "sfx" in out:
        out["sfx"] = [e for e in out["sfx"] if e["track"] not in gone]
        if not out["sfx"]:
            del out["sfx"]
    if "music" not in out and "ambience" not in out:
        out.pop("fadeMs", None)
    return out or None


def carry_dropped_audio(records: list[ItemRecord]) -> None:
    """Give a dropped item's audio to the next item kept, so a cue still
    reaches the next item the reader sees. Its voice goes with its line,
    which is dropped too."""
    carried: dict[str, Any] | None = None
    givers: list[ItemRecord] = []
    for record in records:
        if record.skipped:
            if record.audio:
                audio = dict(record.audio)
                if audio.pop("voice", None) is not None:
                    record.notes.append("voice dropped with the item")
                carried = merge_audio(carried, audio)
                givers.append(record)
                record.audio = None
            continue
        if carried:
            record.audio = merge_audio(carried, record.audio)
            for giver in givers:
                giver.notes.append(f"audio moved to {record.item['id']}")
        carried, givers = None, []
    for giver in givers:
        giver.notes.append("audio dropped: no later item is kept")


def fresh_track_id(stem: str, taken: Container[str]) -> str:
    """A fresh id of the item-id shape from a file's base name."""
    base = _ID_BAD_RE.sub("-", stem).strip("-_")[:56] or "track"
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base}-{n}"
        n += 1
    return candidate


class CueWalker:
    """Attaches the audio cues of one walk to its items (module doc)."""

    def __init__(self, parses: list[tuple[str, FileParse]],
                 files: AudioFiles) -> None:
        self.files = files
        self.tracks: dict[str, AudioTrack] = {}
        self._ids: dict[tuple[Any, ...], str] = {}
        self._defs: dict[str, str | None] = {}
        self._channels = dict(_BUILTIN_CHANNELS)
        self._voice_format = "{filename}"
        for _rel, parsed in parses:
            self._defs.update(parsed.audio_defs)
            self._channels.update(parsed.channels)
        for _rel, parsed in reversed(parses):
            self._voice_format = parsed.config.get(
                "voice_filename_format", self._voice_format)
        version = files.renpy_version()
        self._none_loops = version is None or version < NONE_STOPS_LOOPING
        self._group = _Group()
        self._ambience: dict[str, str] = {}   # slot -> track id
        self._audio_loops = 0
        self._voice: tuple[str, FileParse, str, str] | None = None
        self._lead: tuple[_Group, dict[str, str]] | None = None
        self._route_states: list[dict[str, str]] = []
        self._ambiguous = False

    # --- reading -------------------------------------------------------------

    def statement(self, parsed: FileParse, event: Event) -> None:
        """Read one audio statement into the waiting cues."""
        stmt = event.cue
        assert stmt is not None
        for note in stmt.notes:
            self._report(parsed, event.source, stmt.statement, note)
        channel = self._channels.get(stmt.channel)
        if stmt.action != "voice" and channel is None:
            self._report(parsed, event.source, stmt.statement,
                         UNKNOWN_CHANNEL.format(channel=stmt.channel))
            return
        if channel is not None and channel.movie:
            self._report(parsed, event.source, stmt.statement, MOVIE)
            return
        if stmt.action == "stop":
            self._stop(parsed, event, stmt)
        elif stmt.action == "voice" or stmt.channel == "voice":
            self._read_voice(parsed, event, stmt)
        else:
            assert channel is not None
            self._play(parsed, event, stmt, channel)

    def _play(self, parsed: FileParse, event: Event, stmt: AudioStatement,
              channel: AudioChannel) -> None:
        group, name = self._group, stmt.channel
        if stmt.action == "queue" and name in group.channels:
            self._report(parsed, event.source, stmt.statement, QUEUED)
            return
        loop = stmt.loop if stmt.loop is not None else (
            self._none_loops if channel.loop is None else channel.loop)
        track = self._track(parsed, event, stmt, channel,
                            loop=loop or name != "music")
        if track is None:
            return
        group.channels.add(name)
        group.origins.append((parsed, event.source, stmt.statement))
        if name == "music":
            group.music, group.music_set = track, True
            self._fade(stmt)
            return
        if name != "audio" and self._ambience.pop(name, None) is not None:
            self._ambience_changed(parsed, event, stmt)
        if loop:
            slot = name
            if name == "audio":
                self._audio_loops += 1
                slot = f"audio {self._audio_loops}"
            self._ambience[slot] = track
            self._ambience_changed(parsed, event, stmt)
            return
        shot = {"track": track} if name == "audio" else {
            "track": track, "channel": name}
        group.sfx = [e for e in group.sfx
                     if name == "audio" or e.get("channel") != name]
        group.sfx.append(shot)

    def _stop(self, parsed: FileParse, event: Event,
              stmt: AudioStatement) -> None:
        group, name = self._group, stmt.channel
        group.channels.discard(name)
        if name == "music":
            group.music, group.music_set = None, True
            group.origins.append((parsed, event.source, stmt.statement))
            self._fade(stmt)
            return
        # A sound the same channel started since the last item never
        # reached the reader.
        group.sfx = [e for e in group.sfx if e.get("channel") != name]
        if name in ("audio", "voice"):
            return
        if self._ambience.pop(name, None) is not None:
            group.origins.append((parsed, event.source, stmt.statement))
            self._ambience_changed(parsed, event, stmt)

    def _read_voice(self, parsed: FileParse, event: Event,
                    stmt: AudioStatement) -> None:
        track = self._track(parsed, event, stmt, self._channels["voice"],
                            loop=True, voice=stmt.action == "voice")
        if track is not None:
            self._voice = (track, parsed, event.source, stmt.statement)

    def _ambience_changed(self, parsed: FileParse, event: Event,
                          stmt: AudioStatement) -> None:
        self._group.ambience_set = True
        self._fade(stmt)
        if self._ambiguous:
            self._ambiguous = False
            self._report(parsed, event.source, stmt.statement, AMBIGUOUS)

    def _fade(self, stmt: AudioStatement) -> None:
        self._group.fades += [v for v in (stmt.fadein, stmt.fadeout)
                              if v is not None]

    # --- names and files -----------------------------------------------------

    def _track(self, parsed: FileParse, event: Event, stmt: AudioStatement,
               channel: AudioChannel, loop: bool,
               voice: bool = False) -> str | None:
        """The track id a play names, made on first use; None (after a
        report) when nothing can play."""
        def report(reason: str) -> None:
            self._report(parsed, event.source, stmt.statement, reason)

        if len(stmt.refs) > 1:
            report(PLAYLIST)
        for ref in stmt.refs:
            value = self._resolve(ref, report)
            if value is None:
                return None
            if voice:
                value = self._voice_format.replace("{filename}", value)
            spec = _split_spec(value)
            if spec is None:
                report(UNPARSEABLE)
                return None
            filename, start, loop_start, to, silence = spec
            if silence:
                report(SILENCE)
                continue
            if to:
                report(TO_SPEC)
            name = channel.file_prefix + filename + channel.file_suffix
            source = self.files.find(name)
            if source is None:
                report((MISSING_VOICE if stmt.channel == "voice"
                        else MISSING).format(file=name))
                return None
            if loop_start == start:
                loop_start = None
            volume = 1.0 if stmt.volume is None else stmt.volume
            return self._track_for(source, start, loop_start, volume, loop)
        return None

    def _resolve(self, ref: AudioRef, report: Any) -> str | None:
        if ref.kind == "file":
            return ref.value
        if ref.value in self._defs:
            value = self._defs[ref.value]
            if value is None:
                report(EXPRESSION)
            return value
        value = self.files.names().get(ref.value)
        if value is None:
            report(UNDEFINED.format(name=ref.value))
        return value

    def _track_for(self, source: AudioSource, start: float,
                   loop_start: float | None, volume: float,
                   loop: bool) -> str:
        key = (source.asset, start, loop_start, volume, loop)
        if key not in self._ids:
            stem = Path(source.asset.rsplit("!", 1)[-1]).stem
            track_id = fresh_track_id(stem, self.tracks)
            self.tracks[track_id] = AudioTrack(track_id, source, start,
                                               loop_start, volume, loop)
            self._ids[key] = track_id
        return self._ids[key]

    # --- items ---------------------------------------------------------------

    def attach(self, record: ItemRecord) -> None:
        """An item was emitted: it takes the waiting cues, and the voice
        when it carries a line."""
        audio = self._group.render(self._ambience)
        if self._voice is not None and "text" in record.item:
            audio["voice"] = self._voice[0]
            self._voice = None
        if audio:
            record.audio = merge_audio(record.audio, audio)
        self._group = _Group()

    def line_dropped(self) -> None:
        """A line was dropped with its unresolved visual: so is its
        voice."""
        if self._voice is not None:
            self._report_voice(VOICE_DROPPED)

    def extend_line(self) -> None:
        """An `extend` line joined the item before it
        (kinetic_extract.timeline): a voice waiting for it reaches no
        item of its own. Other waiting cues stay for the next item."""
        if self._voice is not None:
            self._report_voice(VOICE_EXTEND)

    def finish(self) -> None:
        """The walk ended: cues still waiting reached no item."""
        for parsed, source, statement in self._group.origins:
            self._report(parsed, source, statement, AFTER_LAST)
        if self._voice is not None:
            self._report_voice(AFTER_LAST)
        self._group = _Group()

    # --- menus ---------------------------------------------------------------

    def menu_open(self) -> None:
        """A detected menu starts: the waiting cues lead every route."""
        if self._voice is not None:
            self._report_voice(VOICE_MENU)
        self._lead = (self._group, dict(self._ambience))
        self._route_states = []
        self._group = _Group()

    def route_start(self) -> None:
        if self._lead is not None:
            self._group = self._lead[0].copy()
            self._ambience = dict(self._lead[1])

    def route_end(self, last: ItemRecord | None) -> None:
        """A route's block ended; ``last`` is its last item, if any."""
        if self._lead is None:
            return
        trailing = self._group.render(self._ambience)
        if trailing and last is not None:
            last.audio = merge_audio(last.audio, trailing)
        elif trailing:
            for parsed, source, statement in self._group.origins:
                self._report(parsed, source, statement, EMPTY_ROUTE)
        if self._voice is not None:
            self._report_voice(VOICE_NO_LINE)
        self._route_states.append(dict(self._ambience))
        self._group = _Group()

    def menu_close(self) -> None:
        """After the menu the last route's state goes on."""
        if self._lead is None:
            return
        states = self._route_states or [self._lead[1]]
        self._ambiguous = any(set(s.values()) != set(states[-1].values())
                              for s in states)
        self._ambience = dict(states[-1])
        self._lead = None
        self._group = _Group()

    # --- reports -------------------------------------------------------------

    @staticmethod
    def _report(parsed: FileParse, source: str, statement: str,
                reason: str) -> None:
        parsed.reports.append(Report(source, statement, reason))

    def _report_voice(self, reason: str) -> None:
        assert self._voice is not None
        _track, parsed, source, statement = self._voice
        self._report(parsed, source, statement, reason)
        self._voice = None


def _split_spec(value: str) -> tuple[str, float, float | None, bool,
                                     bool] | None:
    """Ren'Py's partial-playback prefix: (file, from, loop, has `to`,
    is silence), or None when the prefix does not parse."""
    m = _SPEC_RE.match(value)
    if not m:
        return value, 0.0, None, False, False
    words = m.group(1).split()
    start, loop_start, to, silence = 0.0, None, False, False
    while words:
        word = words.pop(0)
        if word == "sync" and words:
            words.pop(0)  # a start taken from a playing channel: ignored
            continue
        if word not in ("from", "to", "loop", "silence") or not words:
            return None
        try:
            number = float(words.pop(0))
        except ValueError:
            return None
        if word == "from":
            start = number
        elif word == "loop":
            loop_start = number
        elif word == "to":
            to = True
        else:
            silence = True
    return m.group(2), start, loop_start, to, silence
