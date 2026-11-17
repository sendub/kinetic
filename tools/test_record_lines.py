"""Tests for tools/record_lines.py (docs/plan.md Phase 52, item 13). Run
with:

    .venv/bin/pytest tools/test_record_lines.py -q

The recorder drives the voice helper (apps/voice) with its fake engine, a
tone whose length follows the text, so no model runs here. ffmpeg is the
system one through the media tools' TEST-ONLY override, as in
test_cast_voices.py. Every game folder is synthetic.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import record_lines  # noqa: E402
import validate_content  # noqa: E402
from kinetic_extract import audio_format, language_file, media_tools  # noqa: E402
from kinetic_extract.media_tools import TEST_DIR_ENV, TOOL_NAMES  # noqa: E402
from kinetic_extract.version import kinetic_version  # noqa: E402

HELPER_MAIN = REPO_ROOT / "apps" / "voice" / "kinetic_voice" / "__main__.py"
SHIM_PREFIX = "window.KINETIC_MANIFEST = "


@pytest.fixture(autouse=True)
def system_ffmpeg(tmp_path_factory: pytest.TempPathFactory,
                  monkeypatch: pytest.MonkeyPatch) -> Path:
    tool_dir = tmp_path_factory.mktemp("media-tools")
    for name in TOOL_NAMES:
        found = shutil.which(name)
        if found:
            (tool_dir / name).symlink_to(found)
    monkeypatch.setenv(TEST_DIR_ENV, str(tool_dir))
    return tool_dir


@pytest.fixture
def lock_file(tmp_path: Path) -> Path:
    path = tmp_path / "lock.json"
    path.write_text(json.dumps({
        "id": "fake-1", "wheels": [], "model": [],
        "python": {"url": "", "sha256": "", "size": 0},
        "engine": {"id": "fake", "temperature": 0.8}}))
    return path


@pytest.fixture
def helper_cmd(tmp_path: Path) -> list[str]:
    return [sys.executable, "-I", str(HELPER_MAIN), "--root",
            str(tmp_path / "voice"), "--engine", "fake"]


def write_clip(folder: Path, file: str, hertz: int = 220) -> None:
    """A half-second WAV and its script, a stand-in reference clip."""
    (folder / file).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(folder / file), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(bytes((i * hertz) % 256 for i in range(16000)))
    audio_format.write_script(folder, file)


ITEMS = [
    {"id": "first", "type": "image", "file": "first.png",
     "text": "The harbour at dusk."},
    {"id": "line-1", "type": "text", "speaker": "Mei",
     "text": "You're early today."},
    {"id": "line-2", "type": "text", "speaker": "Old Theo",
     "text": "The tide waits for nobody."},
    {"id": "line-3", "type": "text", "speaker": "Mei", "thought": True,
     "text": "He never says hello."},
    {"id": "line-4", "type": "text", "speaker": "Nobody",
     "text": "No voice for this speaker."},
    {"id": "line-5", "type": "text", "speaker": "Mei",
     "text": "This one has the author's own recording.",
     "audio": {"voice": "mine"}},
    {"id": "line-6", "type": "text", "speaker": "Mei", "text": "   "},
    {"id": "line-7", "type": "text", "speaker": "Mei",
     "text": "You're early today."},
    {"id": "line-8", "type": "text", "speaker": ""},
]


def make_game(tmp_path: Path, indent: int | None = 2,
              items: list[dict] | None = None, name: str = "game") -> Path:
    folder = tmp_path / name
    folder.mkdir()
    write_clip(folder, "voices/mei.wav", 3)
    write_clip(folder, "voices/theo.wav", 5)
    write_clip(folder, "voices/narrator.wav", 7)
    write_clip(folder, "mine.wav", 11)
    (folder / "first.png").write_bytes(b"png stand-in")
    manifest = {
        "schemaVersion": 1, "storyId": "record-test", "title": "Record test",
        "width": 64, "height": 36,
        "voices": {"Mei": {"file": "voices/mei.wav", "text": "Hello Mei."},
                   "Old Theo": {"file": "voices/theo.wav"}},
        "narrator": {"file": "voices/narrator.wav"},
        "audio": {"tracks": {"mine": {"file": "mine.wav",
                                      "durationSeconds": 1}}},
        "items": json.loads(json.dumps(items or ITEMS)),
    }
    write_manifest(folder, manifest, indent)
    return folder


def write_manifest(folder: Path, manifest: dict,
                   indent: int | None = 2) -> None:
    text = json.dumps(manifest, indent=indent) + "\n"
    (folder / "manifest.json").write_text(text, encoding="utf-8")
    (folder / "manifest.js").write_text(f"{SHIM_PREFIX}{text.strip()};\n",
                                        encoding="utf-8")


def load(folder: Path) -> dict:
    return json.loads((folder / "manifest.json").read_text("utf-8"))


def record(folder: Path, lock_file: Path, helper_cmd: list[str],
           *extra: str) -> int:
    return record_lines.main(
        [str(folder), "--lock", str(lock_file), *extra],
        helper_command=helper_cmd)


def owned(manifest: dict) -> dict[str, dict]:
    return {tid: t for tid, t in manifest["audio"]["tracks"].items()
            if tid != "mine"}


def voice_of(manifest: dict, item_id: str) -> str | None:
    item = next(i for i in manifest["items"] if i["id"] == item_id)
    return item.get("audio", {}).get("voice")


def snapshot(folder: Path) -> dict[str, bytes]:
    return {str(p.relative_to(folder)): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


class Calls(list):
    """The text of every line asked for; `langs` holds (text, lang)."""

    def __init__(self) -> None:
        super().__init__()
        self.langs: list[tuple[str, str | None]] = []

    def clear(self) -> None:
        super().clear()
        self.langs.clear()


@pytest.fixture
def speak_calls(monkeypatch: pytest.MonkeyPatch) -> Calls:
    """The text of every line the helper is asked to speak (and in its
    `langs`, with the language asked for)."""
    calls = Calls()
    real = record_lines.HelperClient.speak

    def spy(self, voice_id, text, lang=None):
        calls.append(text)
        calls.langs.append((text, lang))
        return real(self, voice_id, text, lang)

    monkeypatch.setattr(record_lines.HelperClient, "speak", spy)
    return calls


def probe(path: Path) -> dict:
    out = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-show_entries",
         "stream=codec_name,channels:format=format_name,duration", "-of",
         "json", str(path)], capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


# --- which lines -------------------------------------------------------------

def test_chooses_the_lines_the_player_would_speak(tmp_path, lock_file,
                                                  helper_cmd, speak_calls):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    manifest = load(game)
    assert voice_of(manifest, "first")  # the narrator
    assert voice_of(manifest, "line-1")
    assert voice_of(manifest, "line-2")
    assert voice_of(manifest, "line-3")  # a thought, in Mei's voice
    assert voice_of(manifest, "line-4") is None  # a speaker with no voice
    assert voice_of(manifest, "line-5") == "mine"  # the author's recording
    assert voice_of(manifest, "line-6") is None  # blank text
    assert voice_of(manifest, "line-8") is None  # no text
    assert sorted(speak_calls) == sorted([
        "The harbour at dusk.", "You're early today.",
        "The tide waits for nobody.", "He never says hello."])


def test_the_rule_matches_the_players(tmp_path):
    """record_lines.spoken_lines mirrors player/src/render/spoken.ts's
    `spokenLine`; this keeps the two in step by checking the player's
    source still holds the rule's every clause."""
    source = (REPO_ROOT / "player/src/render/spoken.ts").read_text()
    body = source[source.index("export function spokenLine"):]
    body = body[:body.index("\n}\n")]
    for clause in ('text === undefined || text.trim() === ""',
                   "item.audio?.voice !== undefined",
                   'speaker === undefined || speaker === "" ? NARRATOR',
                   "castVoice(cast, voice) === undefined"):
        assert clause in body, f"spoken.ts changed: {clause!r} is gone"


def test_the_language_rule_matches_the_players():
    """record_lines.language_lines mirrors player/src/render/linevoice.ts's
    `lineVoice` for translated text; this checks the player's source still
    holds each clause, in that order."""
    source = (REPO_ROOT / "player/src/render/linevoice.ts").read_text()
    body = source[source.index("export function lineVoice"):]
    body = body[:body.index("\n}\n")]
    at = 0
    for clause in ("fileItemText(file, item.id)",
                   "fileRecording(file, item.id)",
                   "file.keepOriginalVoice === true && base !== undefined",
                   "engineLanguage(file.language)",
                   "castVoice(cast, voice) === undefined"):
        found = body.find(clause, at)
        assert found >= 0, f"linevoice.ts changed: {clause!r} is gone"
        at = found


def test_identical_lines_share_one_file(tmp_path, lock_file, helper_cmd):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    manifest = load(game)
    assert voice_of(manifest, "line-1") == voice_of(manifest, "line-7")
    tracks = owned(manifest)
    assert len(tracks) == 4
    assert len({t["file"] for t in tracks.values()}) == 4
    webm = [p for p in (game).rglob("*.webm")]
    assert len(webm) == 4


# --- what is written ----------------------------------------------------------

def test_files_scripts_tracks_and_validation(tmp_path, lock_file,
                                             helper_cmd):
    game = make_game(tmp_path, indent=4)
    assert record(game, lock_file, helper_cmd, "--bitrate", "16") == 0
    text = (game / "manifest.json").read_text("utf-8")
    manifest = json.loads(text)
    assert text == json.dumps(manifest, indent=4) + "\n"
    assert (game / "manifest.js").read_text("utf-8") == (
        f"{SHIM_PREFIX}{text.strip()};\n")
    assert manifest["audio"]["tracks"]["mine"] == {
        "file": "mine.wav", "durationSeconds": 1}
    for track in owned(manifest).values():
        path = game / track["file"]
        script = audio_format.script_path(game, track["file"])
        assert audio_format.script_problem(
            track["file"], script.read_bytes(), path.read_bytes()) is None
        info = probe(path)
        assert info["streams"][0]["codec_name"] == "opus"
        assert info["streams"][0]["channels"] == 1
        assert "webm" in info["format"]["format_name"]
        assert abs(float(info["format"]["duration"])
                   - track["durationSeconds"]) < 0.1
    # The fake engine's line is 0.2 s plus 0.05 s a character.
    first = owned(manifest)[voice_of(manifest, "first")]
    assert first["durationSeconds"] == pytest.approx(
        0.2 + 0.05 * len("The harbour at dusk."), abs=0.01)
    assert validate_content.main([str(game)]) == 0


def test_a_folder_without_a_shim_gets_none(tmp_path, lock_file, helper_cmd):
    game = make_game(tmp_path)
    (game / "manifest.js").unlink()
    assert record(game, lock_file, helper_cmd) == 0
    assert not (game / "manifest.js").exists()


def test_compact_manifest_stays_compact(tmp_path, lock_file, helper_cmd):
    game = make_game(tmp_path, indent=None)
    assert record(game, lock_file, helper_cmd) == 0
    text = (game / "manifest.json").read_text("utf-8")
    assert text.count("\n") == 1  # the one line and its newline


def test_the_same_audio_every_time(tmp_path, lock_file, helper_cmd):
    first = make_game(tmp_path, name="a")
    second = make_game(tmp_path, name="b")
    assert record(first, lock_file, helper_cmd) == 0
    assert record(second, lock_file, helper_cmd) == 0
    assert snapshot(first) == snapshot(second)


# --- reruns ---------------------------------------------------------------------

def test_a_rerun_records_nothing(tmp_path, lock_file, helper_cmd,
                                 speak_calls):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    before = snapshot(game)
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd) == 0
    assert speak_calls == []
    assert snapshot(game) == before


def test_a_changed_line_records_only_itself(tmp_path, lock_file, helper_cmd,
                                            speak_calls):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    before = load(game)
    old_id = voice_of(before, "line-2")
    old_file = owned(before)[old_id]["file"]
    other = {tid: t["file"] for tid, t in owned(before).items()
             if tid != old_id}
    others = {f: (game / f).read_bytes() for f in other.values()}

    manifest = load(game)
    next(i for i in manifest["items"] if i["id"] == "line-2")["text"] = (
        "The tide waits for no one at all.")
    write_manifest(game, manifest)
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd) == 0
    assert speak_calls == ["The tide waits for no one at all."]

    after = load(game)
    new_id = voice_of(after, "line-2")
    assert new_id != old_id
    assert old_id not in after["audio"]["tracks"]
    assert not (game / old_file).exists()
    assert not audio_format.script_path(game, old_file).exists()
    assert "mine" in after["audio"]["tracks"]
    for tid, f in other.items():
        assert after["audio"]["tracks"][tid]["file"] == f
        assert (game / f).read_bytes() == others[f]
    assert validate_content.main([str(game)]) == 0


def test_a_line_no_longer_spoken_loses_its_track(tmp_path, lock_file,
                                                 helper_cmd):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    before = load(game)
    gone = owned(before)[voice_of(before, "line-2")]["file"]
    manifest = load(game)
    next(i for i in manifest["items"] if i["id"] == "line-2")["text"] = " "
    write_manifest(game, manifest)
    assert record(game, lock_file, helper_cmd) == 0
    after = load(game)
    assert voice_of(after, "line-2") is None
    item = next(i for i in after["items"] if i["id"] == "line-2")
    assert "audio" not in item  # the empty object goes too
    assert not (game / gone).exists()
    assert len(owned(after)) == 3


def test_every_recording_is_removed_when_no_line_needs_one(
        tmp_path, lock_file, helper_cmd):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    manifest = load(game)
    del manifest["voices"], manifest["narrator"]
    write_manifest(game, manifest)
    assert record(game, lock_file, helper_cmd) == 0
    after = load(game)
    assert after["audio"]["tracks"] == {"mine": {"file": "mine.wav",
                                                 "durationSeconds": 1}}
    assert not list(game.rglob("*.webm"))


def test_a_new_clip_or_transcript_makes_new_files(tmp_path, lock_file,
                                                  helper_cmd, speak_calls):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    before = load(game)
    speak_calls.clear()
    manifest = load(game)
    manifest["voices"]["Mei"]["text"] = "A different transcript."
    write_manifest(game, manifest)
    assert record(game, lock_file, helper_cmd) == 0
    assert sorted(speak_calls) == sorted(["You're early today.",
                                          "He never says hello."])
    after = load(game)
    assert voice_of(after, "line-2") == voice_of(before, "line-2")
    assert voice_of(after, "line-1") != voice_of(before, "line-1")


def test_a_changed_bitrate_makes_new_files(tmp_path, lock_file, helper_cmd,
                                           speak_calls):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd, "--bitrate", "12") == 0
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd, "--bitrate", "24") == 0
    assert len(speak_calls) == 4
    assert len(list(game.rglob("*.webm"))) == 4


def test_it_never_touches_tracks_it_did_not_make(tmp_path, lock_file,
                                                 helper_cmd):
    game = make_game(tmp_path)
    manifest = load(game)
    manifest["audio"]["tracks"]["rec-lookalike"] = {
        "file": "mine.wav", "durationSeconds": 1}
    manifest["audio"]["tracks"]["theme"] = {"file": "mine.wav",
                                            "durationSeconds": 1}
    manifest["items"][0]["audio"] = {"music": "theme"}
    write_manifest(game, manifest)
    assert record(game, lock_file, helper_cmd) == 0
    assert record(game, lock_file, helper_cmd) == 0
    after = load(game)
    assert after["audio"]["tracks"]["rec-lookalike"]["file"] == "mine.wav"
    assert after["audio"]["tracks"]["theme"]["file"] == "mine.wav"
    assert after["items"][0]["audio"]["music"] == "theme"
    assert (game / "mine.wav").is_file()


# --- interruption ----------------------------------------------------------------

def test_an_interrupted_run_resumes(tmp_path, lock_file, helper_cmd,
                                    speak_calls, monkeypatch):
    game = make_game(tmp_path)
    real = record_lines.encode_opus
    done: list[int] = []

    def stop_on_third(wav, path, bitrate):
        if len(done) == 2:
            raise KeyboardInterrupt
        real(wav, path, bitrate)
        done.append(1)

    monkeypatch.setattr(record_lines, "encode_opus", stop_on_third)
    assert record(game, lock_file, helper_cmd) == 130
    saved = load(game)
    assert len(owned(saved)) == 2  # Ctrl-C saved what was done
    assert len(list(game.rglob("*.webm"))) == 2
    assert not list(game.rglob("*.tmp"))

    monkeypatch.setattr(record_lines, "encode_opus", real)
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd) == 0
    assert len(speak_calls) == 2
    assert len(owned(load(game))) == 4
    assert validate_content.main([str(game)]) == 0


def test_files_on_disk_without_tracks_are_reused(tmp_path, lock_file,
                                                 helper_cmd, speak_calls):
    """A kill between two saves leaves files the manifest does not know."""
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    done = load(game)
    manifest = load(game)
    for tid in owned(manifest):
        del manifest["audio"]["tracks"][tid]
    for item in manifest["items"]:
        if item.get("audio", {}).get("voice") != "mine":
            item.pop("audio", None)
    write_manifest(game, manifest)
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd) == 0
    assert speak_calls == []
    after = load(game)
    assert after["audio"]["tracks"].keys() == done["audio"]["tracks"].keys()
    for tid, track in owned(after).items():
        assert track["durationSeconds"] == pytest.approx(
            owned(done)[tid]["durationSeconds"], abs=0.05)


# --- dry run, options ---------------------------------------------------------------

def test_dry_run_touches_nothing_and_starts_no_engine(tmp_path, lock_file,
                                                      capsys):
    game = make_game(tmp_path)
    before = snapshot(game)
    assert record_lines.main(
        [str(game), "--lock", str(lock_file), "--dry-run"],
        helper_command=["/nonexistent/helper"]) == 0
    assert snapshot(game) == before
    out = capsys.readouterr().out
    assert "4 lines to record" in out
    assert "0 recorded" in out
    assert "estimate" in out.lower()


def test_dry_run_counts_what_is_recorded(tmp_path, lock_file, helper_cmd,
                                         capsys):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    capsys.readouterr()
    assert record_lines.main(
        [str(game), "--lock", str(lock_file), "--dry-run"],
        helper_command=["/nonexistent/helper"]) == 0
    out = capsys.readouterr().out
    assert "0 lines to record" in out
    assert "4 recorded" in out


def test_summary_and_progress(tmp_path, lock_file, helper_cmd, capsys):
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd) == 0
    err = capsys.readouterr()
    out = err.out + err.err
    assert "4 recorded" in out
    assert "real time" in out.lower()
    assert record(game, lock_file, helper_cmd) == 0
    assert "4 reused" in (capsys.readouterr().out)


def test_version(capsys):
    with pytest.raises(SystemExit) as stop:
        record_lines.build_parser().parse_args(["--version"])
    assert stop.value.code == 0
    assert capsys.readouterr().out.strip() == f"Kinetic {kinetic_version()}"


def test_refusals(tmp_path, lock_file, helper_cmd, capsys):
    assert record(tmp_path / "missing", lock_file, helper_cmd) == 2
    game = make_game(tmp_path)
    assert record(game, lock_file, helper_cmd, "--bitrate", "0") == 2
    manifest = load(game)
    manifest["voices"]["Mei"]["file"] = "voices/mei.m4a"
    write_manifest(game, manifest)
    assert record(game, lock_file, helper_cmd) == 1
    assert "m4a" in capsys.readouterr().err
    manifest = load(game)
    del manifest["voices"], manifest["narrator"]
    write_manifest(game, manifest)
    # Nothing is cast and nothing recorded: not an error.
    assert record(game, lock_file, helper_cmd) == 0


# --- --lang: a language file's lines (docs/plan.md Phase 54 item 6) -----------

GERMAN = {
    "first": "Der Hafen in der Dämmerung.",
    "line-1": "Du bist heute früh dran.",
    "line-2": "Die Flut wartet auf niemanden.",
    "line-4": "Keine Stimme für diesen Sprecher.",
    "line-5": "Diese Zeile hat die Aufnahme der Autorin.",
    "line-7": "Du bist heute früh dran.",
}


def add_language(game: Path, tag: str, texts: dict[str, str],
                 **fields: object) -> None:
    """List `tag` in the manifest and write its language file."""
    manifest = load(game)
    manifest["languages"] = sorted({*manifest.get("languages", []), tag})
    write_manifest(game, manifest)
    language_file.write_language_file(game, {
        "language": tag,
        "items": {item_id: {"text": text} for item_id, text in texts.items()},
        **fields})


def load_lang(game: Path, tag: str) -> dict:
    return json.loads((game / f"lang/{tag}.json").read_text("utf-8"))


def lang_voice(data: dict, item_id: str) -> str | None:
    return data.get("voice", {}).get("items", {}).get(item_id)


def test_lang_records_the_translated_lines(tmp_path, lock_file, helper_cmd,
                                           speak_calls):
    game = make_game(tmp_path)
    add_language(game, "de", GERMAN)
    before = (game / "manifest.json").read_bytes()
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    # Each distinct translated line once, in German.
    assert sorted(speak_calls.langs) == sorted([
        ("Der Hafen in der Dämmerung.", "de"),
        ("Du bist heute früh dran.", "de"),
        ("Die Flut wartet auf niemanden.", "de"),
        ("Diese Zeile hat die Aufnahme der Autorin.", "de")])
    assert (game / "manifest.json").read_bytes() == before
    data = load_lang(game, "de")
    assert lang_voice(data, "first")  # the narrator
    assert lang_voice(data, "line-1") == lang_voice(data, "line-7")
    assert lang_voice(data, "line-2")
    assert lang_voice(data, "line-3") is None  # not translated
    assert lang_voice(data, "line-4") is None  # no voice for the speaker
    # The base has the author's recording, but without keepOriginalVoice
    # it is silent under German, so German gets its own line.
    assert lang_voice(data, "line-5")
    tracks = data["voice"]["tracks"]
    assert len(tracks) == 4
    for tid, track in tracks.items():
        assert tid.startswith("rec-")
        assert track["file"].startswith("lang/de/lines/")
        path = game / track["file"]
        script = audio_format.script_path(game, track["file"])
        assert audio_format.script_problem(
            track["file"], script.read_bytes(), path.read_bytes()) is None
        assert probe(path)["streams"][0]["codec_name"] == "opus"
    assert not (game / "lines").exists()
    # Its script agrees with it, and the folder validates.
    text = (game / "lang/de.json").read_text("utf-8")
    assert (game / "lang/de.js").read_text("utf-8") == \
        language_file.script_text("de", text)
    assert validate_content.validate_folder(game) == []


def test_lang_uses_the_engine_s_language(tmp_path, lock_file, helper_cmd,
                                         speak_calls):
    game = make_game(tmp_path)
    add_language(game, "ja", {"line-1": "今日は早いね。"})
    add_language(game, "nb", {"line-2": "Tidevannet venter ikke."})
    add_language(game, "pt-BR", {"line-2": "A maré não espera ninguém."})
    assert record(game, lock_file, helper_cmd, "--lang", "ja") == 0
    assert record(game, lock_file, helper_cmd, "--lang", "nb") == 0
    assert record(game, lock_file, helper_cmd, "--lang", "pt-BR") == 0
    assert speak_calls.langs == [("今日は早いね。", "ja"),
                                 ("Tidevannet venter ikke.", "no"),
                                 ("A maré não espera ninguém.", "pt")]
    assert load_lang(game, "pt-BR")["voice"]["tracks"]
    assert all(t["file"].startswith("lang/pt-BR/lines/")
               for t in load_lang(game, "pt-BR")["voice"]["tracks"].values())


def test_lang_keeps_the_base_voice_and_the_author_s_own(tmp_path, lock_file,
                                                        helper_cmd,
                                                        speak_calls):
    game = make_game(tmp_path)
    (game / "lang/de/mine").mkdir(parents=True)
    write_clip(game, "lang/de/mine/line-2.wav", 13)
    add_language(game, "de", GERMAN, keepOriginalVoice=True, voice={
        "tracks": {"theo-de": {"file": "lang/de/mine/line-2.wav",
                               "durationSeconds": 1}},
        "items": {"line-2": "theo-de"}})
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    assert sorted(speak_calls) == sorted(["Der Hafen in der Dämmerung.",
                                          "Du bist heute früh dran."])
    data = load_lang(game, "de")
    assert lang_voice(data, "line-2") == "theo-de"
    assert data["voice"]["tracks"]["theo-de"]["file"] == \
        "lang/de/mine/line-2.wav"
    assert lang_voice(data, "line-5") is None  # the base recording plays
    assert validate_content.validate_folder(game) == []


def test_lang_rerun_and_cleanup(tmp_path, lock_file, helper_cmd,
                                speak_calls):
    game = make_game(tmp_path)
    add_language(game, "de", GERMAN)
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    before = snapshot(game)
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    assert speak_calls == []
    assert snapshot(game) == before

    data = load_lang(game, "de")
    gone = data["voice"]["tracks"][lang_voice(data, "line-2")]["file"]
    del data["items"]["line-2"]
    data["items"]["line-1"]["text"] = "Du bist früh."
    language_file.write_language_file(game, data)
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    assert speak_calls == ["Du bist früh."]
    after = load_lang(game, "de")
    assert lang_voice(after, "line-2") is None
    assert not (game / gone).exists()
    # line-7 keeps the old text, and so the old file.
    assert lang_voice(after, "line-1") != lang_voice(after, "line-7")
    assert len(after["voice"]["tracks"]) == 4
    assert validate_content.validate_folder(game) == []

    # With nothing left to speak, the voice block goes.
    after["keepOriginalVoice"] = False
    after["items"] = {}
    language_file.write_language_file(game, after)
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    assert "voice" not in load_lang(game, "de")
    assert not list((game / "lang").rglob("*.webm"))


def test_lang_and_the_manifest_s_lines_are_apart(tmp_path, lock_file,
                                                  helper_cmd):
    game = make_game(tmp_path)
    add_language(game, "de", GERMAN)
    assert record(game, lock_file, helper_cmd) == 0
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    manifest = load(game)
    assert len(owned(manifest)) == 4
    assert all(t["file"].startswith("lines/")
               for t in owned(manifest).values())
    # A rerun of either leaves the other alone.
    before = snapshot(game)
    assert record(game, lock_file, helper_cmd) == 0
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
    assert snapshot(game) == before
    assert validate_content.validate_folder(game) == []


def test_lang_dry_run(tmp_path, lock_file, capsys):
    game = make_game(tmp_path)
    add_language(game, "de", GERMAN)
    before = snapshot(game)
    assert record_lines.main(
        [str(game), "--lock", str(lock_file), "--lang", "de", "--dry-run"],
        helper_command=["/nonexistent/helper"]) == 0
    assert snapshot(game) == before
    out = capsys.readouterr().out
    assert "5 items speak live in de, 4 distinct lines" in out
    assert "4 lines to record, 0 recorded" in out


def test_lang_refusals(tmp_path, lock_file, helper_cmd, capsys):
    game = make_game(tmp_path)
    add_language(game, "vi", {"line-1": "Hôm nay bạn đến sớm."})
    before = snapshot(game)
    assert record(game, lock_file, helper_cmd, "--lang", "vi") == 2
    err = capsys.readouterr().err
    assert "the voice engine does not speak 'vi'" in err
    assert "de, el, en" in err
    assert record(game, lock_file, helper_cmd, "--lang", "fr") == 2
    assert "the game has no language 'fr'" in capsys.readouterr().err
    assert record(game, lock_file, helper_cmd, "--lang", "vi",
                  "--dry-run") == 2
    assert snapshot(game) == before


# --- the base language (docs/plan.md Phase 54 item 6b) -----------------------

def set_language(game: Path, tag: str) -> None:
    manifest = load(game)
    manifest["language"] = tag
    write_manifest(game, manifest)


def test_a_german_base_is_spoken_in_german(tmp_path, lock_file, helper_cmd,
                                           speak_calls):
    game = make_game(tmp_path)
    set_language(game, "de-AT")
    assert record(game, lock_file, helper_cmd) == 0
    assert sorted(speak_calls.langs) == sorted([
        ("The harbour at dusk.", "de"), ("You're early today.", "de"),
        ("The tide waits for nobody.", "de"),
        ("He never says hello.", "de")])
    manifest = load(game)
    assert voice_of(manifest, "line-1")
    assert all(t["file"].startswith("lines/")
               for t in owned(manifest).values())
    assert validate_content.validate_folder(game) == []
    # A rerun records nothing.
    speak_calls.clear()
    assert record(game, lock_file, helper_cmd) == 0
    assert speak_calls == []


def test_an_english_base_keeps_its_keys(tmp_path, lock_file, helper_cmd,
                                        speak_calls):
    """Recordings made before languages existed stay valid: an English
    base (named or not) asks the helper for its default and keys its lines
    without a language; a German base keys them apart."""
    tracks = {}
    for tag in (None, "en", "en-GB", "de"):
        game = make_game(tmp_path, name=f"game-{tag}")
        if tag is not None:
            set_language(game, tag)
        speak_calls.clear()
        assert record(game, lock_file, helper_cmd) == 0
        assert {lang for _, lang in speak_calls.langs} == \
            ({"de"} if tag == "de" else {None})
        tracks[tag] = set(owned(load(game)))
    assert tracks["en"] == tracks[None] == tracks["en-GB"]
    assert tracks["de"].isdisjoint(tracks[None])


def test_a_base_language_the_engine_lacks_is_refused(tmp_path, lock_file,
                                                     helper_cmd, capsys):
    game = make_game(tmp_path)
    set_language(game, "vi")
    before = snapshot(game)
    assert record(game, lock_file, helper_cmd) == 2
    err = capsys.readouterr().err
    assert "the game's language is 'vi'" in err
    assert "the voice engine does not speak" in err
    assert "de, el, en" in err
    assert record(game, lock_file, helper_cmd, "--dry-run") == 2
    assert snapshot(game) == before
    # A translation's lines do not depend on the base's language.
    add_language(game, "de", GERMAN)
    assert record(game, lock_file, helper_cmd, "--lang", "de") == 0
