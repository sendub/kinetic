"""Tests for tools/cast_voices.py (docs/plan.md Phase 52, item 5). Run
with:

    .venv/bin/pytest tools/test_cast_voices.py -q

Casting designs character voices with Qwen3-TTS VoiceDesign (`design`),
copies a chosen take into a game as its voice (`pick`), or uses the
author's own clip (`record`). No model runs here: `design` gets a fake
generator, so these tests run anywhere. ffmpeg is the system one through
the media tools' TEST-ONLY override, as in the converter's tests. Every
game folder is synthetic.
"""

from __future__ import annotations

import difflib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import cast_voices  # noqa: E402
import validate_content  # noqa: E402
from kinetic_extract import audio_format  # noqa: E402
from kinetic_extract.media_tools import TEST_DIR_ENV, TOOL_NAMES  # noqa: E402
from kinetic_extract.version import kinetic_version  # noqa: E402

SHIM_PREFIX = "window.KINETIC_MANIFEST = "
PHRASE = ("Hello there. I've been waiting a long time to tell you this "
          "story, so please, sit down and listen. Some of it is funny, some "
          "of it is sad, and all of it is true.")
PICTURE = {"id": "picture", "type": "image", "file": "first.png"}
DESCRIPTIONS = {
    "Mei": "A bright, quick young woman, warm and wry.",
    "Old Theo": "An old man with a slow, gravelly voice & a kind laugh.",
    "narrator": "A calm, clear storyteller in middle age.",
}


@pytest.fixture(autouse=True)
def system_ffmpeg(tmp_path_factory: pytest.TempPathFactory,
                  monkeypatch: pytest.MonkeyPatch) -> Path:
    """The media tools' TEST-ONLY override -> links to the system
    ffmpeg/ffprobe (converter/tests/conftest.py does the same)."""
    tool_dir = tmp_path_factory.mktemp("media-tools")
    for name in TOOL_NAMES:
        found = shutil.which(name)
        if found:
            (tool_dir / name).symlink_to(found)
    monkeypatch.setenv(TEST_DIR_ENV, str(tool_dir))
    return tool_dir


class FakeGenerator:
    """Stands in for the model: half a second of a tone per take, its
    pitch from the seed, and a record of every call."""

    sample_rate = 24000

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int]] = []

    def __call__(self, description: str, phrase: str,
                 seed: int) -> tuple[list[float], int]:
        self.calls.append((description, phrase, seed))
        pitch = 200 + 10 * seed
        count = self.sample_rate // 2
        return ([0.3 * math.sin(2 * math.pi * pitch * i / self.sample_rate)
                 for i in range(count)], self.sample_rate)


def manifest_text(manifest: dict) -> str:
    return json.dumps(manifest, indent=2) + "\n"


def make_game(tmp_path: Path, manifest: dict | None = None,
              text: str | None = None) -> Path:
    """A tiny game folder: one picture, two speakers and a narrated line,
    manifest.json with its shim."""
    folder = tmp_path / "my-novel"
    folder.mkdir()
    (folder / "first.png").write_bytes(b"png stand-in")
    if manifest is None:
        manifest = {
            "schemaVersion": 1, "storyId": "cast-test", "title": "Cast test",
            "width": 64, "height": 36,
            "items": [
                {"id": "first", "type": "image", "file": "first.png",
                 "text": "The harbour at dusk."},
                {"id": "line-1", "type": "text", "speaker": "Mei",
                 "text": "You're early today."},
                {"id": "line-2", "type": "text", "speaker": "Old Theo",
                 "text": "The tide waits for nobody."},
            ]}
    if text is None:
        text = manifest_text(manifest)
    (folder / "manifest.json").write_text(text, encoding="utf-8")
    (folder / "manifest.js").write_text(f"{SHIM_PREFIX}{text.strip()};\n",
                                        encoding="utf-8")
    return folder


def write_descriptions(tmp_path: Path, descriptions: dict | None = None
                       ) -> Path:
    path = tmp_path / "descriptions.json"
    path.write_text(json.dumps(DESCRIPTIONS if descriptions is None
                               else descriptions), encoding="utf-8")
    return path


def run(argv: list[str], generator: FakeGenerator | None = None) -> int:
    return cast_voices.main(argv, generator=generator)


def designed(tmp_path: Path, takes: int = 2,
             descriptions: dict | None = None) -> tuple[Path, Path]:
    """A game and its casting folder with `takes` takes per voice."""
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path, descriptions)
    assert run(["design", str(game), str(desc), "--takes", str(takes)],
               FakeGenerator()) == 0
    return game, tmp_path / "my-novel-casting"


def flac_info(path: Path) -> tuple[int, int]:
    """(sample rate, channels) from a FLAC file's STREAMINFO block."""
    data = path.read_bytes()
    assert data[:4] == b"fLaC"
    info = data[8:42]
    rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4)
    channels = ((info[12] >> 1) & 0x7) + 1
    return rate, channels


def synthetic_wav(path: Path, seconds: float, rate: int = 22050,
                  channels: int = 2) -> Path:
    frames = int(seconds * rate)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(b"".join(
            struct.pack("<h", int(8000 * math.sin(i / 20))) * channels
            for i in range(frames)))
    return path


def single_insertion(old: str, new: str) -> str:
    """The one contiguous block `new` adds to `old`; fails when `new`
    changes anything else."""
    prefix = 0
    while prefix < len(old) and old[prefix] == new[prefix]:
        prefix += 1
    suffix = 0
    while (suffix < len(old) - prefix
           and old[len(old) - 1 - suffix] == new[len(new) - 1 - suffix]):
        suffix += 1
    assert old == new[:prefix] + new[len(new) - suffix:], "not one insertion"
    return new[prefix:len(new) - suffix]


def only_insertions(old: str, new: str) -> None:
    """Fails unless `new` is `old` with text inserted and none changed."""
    opcodes = difflib.SequenceMatcher(None, old, new,
                                      autojunk=False).get_opcodes()
    assert {tag for tag, *_ in opcodes} <= {"equal", "insert"}


# --- design ------------------------------------------------------------------

def test_design_writes_takes_a_listening_page_and_the_record(
        tmp_path: Path) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path)
    fake = FakeGenerator()
    assert run(["design", str(game), str(desc), "--takes", "2"], fake) == 0
    casting = tmp_path / "my-novel-casting"
    for slug in ("mei", "old-theo", "narrator"):
        for take in (1, 2):
            with wave.open(str(casting / f"{slug}-{take}.wav")) as wav:
                assert wav.getnchannels() == 1
                assert wav.getframerate() == 24000
                assert wav.getnframes() == 12000
    assert len(fake.calls) == 6
    assert all(phrase == PHRASE for _, phrase, _ in fake.calls)
    seeds = [seed for d, _, seed in fake.calls if d == DESCRIPTIONS["Mei"]]
    assert len(set(seeds)) == 2

    record = json.loads((casting / "casting.json").read_text("utf-8"))
    assert record["phrase"] == PHRASE
    assert record["model"] == {"id": cast_voices.MODEL_ID,
                               "revision": cast_voices.MODEL_REVISION}
    assert record["narratorKey"] == "narrator"
    mei = record["voices"]["Mei"]
    assert mei["description"] == DESCRIPTIONS["Mei"]
    assert [t["file"] for t in mei["takes"]] == ["mei-1.wav", "mei-2.wav"]
    assert [t["seed"] for t in mei["takes"]] == seeds
    assert record["voices"]["narrator"]["role"] == "narrator"
    assert mei["role"] == "speaker"

    page = (casting / "index.html").read_text("utf-8")
    assert page.startswith("<!DOCTYPE html>")
    for slug in ("mei", "old-theo", "narrator"):
        for take in (1, 2):
            assert f'src="{slug}-{take}.wav"' in page
    assert "Old Theo" in page
    assert "gravelly voice &amp; a kind laugh" in page
    assert "Mei=2" in page  # the pick argument for that take


def test_design_never_writes_into_the_game(tmp_path: Path) -> None:
    game = make_game(tmp_path)
    before = sorted(p.name for p in game.rglob("*"))
    desc = write_descriptions(tmp_path)
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    assert sorted(p.name for p in game.rglob("*")) == before
    assert run(["design", str(game), str(desc), "--out",
                str(game / "casting")], FakeGenerator()) == 2


def test_design_out_moves_the_casting_folder(tmp_path: Path) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path, {"Mei": "Bright."})
    out = tmp_path / "elsewhere"
    assert run(["design", str(game), str(desc), "--takes", "1", "--out",
                str(out)], FakeGenerator()) == 0
    assert (out / "mei-1.wav").is_file()
    assert not (tmp_path / "my-novel-casting").exists()


def test_design_skips_takes_it_already_made(tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=2)
    first = (casting / "mei-1.wav").read_bytes()
    again = FakeGenerator()
    desc = tmp_path / "descriptions.json"
    assert run(["design", str(game), str(desc), "--takes", "2"], again) == 0
    assert again.calls == []
    more = FakeGenerator()
    assert run(["design", str(game), str(desc), "--takes", "3"], more) == 0
    assert len(more.calls) == 3  # take 3 of each voice only
    assert (casting / "mei-1.wav").read_bytes() == first
    record = json.loads((casting / "casting.json").read_text("utf-8"))
    assert len(record["voices"]["Mei"]["takes"]) == 3


def test_design_again_makes_new_takes_with_new_seeds(tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=2)
    old = json.loads((casting / "casting.json").read_text("utf-8"))
    old_seeds = {t["seed"] for t in old["voices"]["Mei"]["takes"]}
    fresh = FakeGenerator()
    assert run(["design", str(game), str(tmp_path / "descriptions.json"),
                "--takes", "2", "--again", "--speakers", "Mei"], fresh) == 0
    assert len(fresh.calls) == 2
    assert not {seed for _, _, seed in fresh.calls} & old_seeds
    new = json.loads((casting / "casting.json").read_text("utf-8"))
    assert new["voices"]["Old Theo"] == old["voices"]["Old Theo"]


def test_a_changed_description_gets_new_takes(tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=2)
    changed = dict(DESCRIPTIONS, Mei="A husky, slow-talking young woman.")
    desc = write_descriptions(tmp_path, changed)
    fake = FakeGenerator()
    assert run(["design", str(game), str(desc), "--takes", "2"], fake) == 0
    assert [d for d, _, _ in fake.calls] == [changed["Mei"]] * 2
    record = json.loads((casting / "casting.json").read_text("utf-8"))
    assert record["voices"]["Mei"]["description"] == changed["Mei"]


def test_design_warns_about_a_speaker_no_item_uses(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path, {"Mei": "Bright.",
                                         "Ghost": "A whisper."})
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    err = capsys.readouterr().err
    assert "Ghost" in err and "no item's speaker" in err
    assert "'Mei'" not in err
    assert (tmp_path / "my-novel-casting" / "ghost-1.wav").is_file()


def test_design_warns_about_a_narrator_with_nothing_to_narrate(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    manifest = {"schemaVersion": 1, "storyId": "s", "width": 64,
                "height": 36, "items": [PICTURE,
                    {"id": "a", "type": "text", "speaker": "Mei",
                     "text": "Hi."}]}
    game = make_game(tmp_path, manifest)
    desc = write_descriptions(tmp_path, {"narrator": "Calm."})
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    assert "no item has text without a speaker" in capsys.readouterr().err


def test_narrator_key_lets_a_speaker_be_called_narrator(
        tmp_path: Path) -> None:
    manifest = {"schemaVersion": 1, "storyId": "s", "width": 64,
                "height": 36, "items": [PICTURE,
                    {"id": "a", "type": "text", "speaker": "narrator",
                     "text": "I am a character called narrator."},
                    {"id": "b", "type": "text", "text": "Plain narration."}]}
    game = make_game(tmp_path, manifest)
    desc = write_descriptions(tmp_path, {"narrator": "A character.",
                                         "*": "The storyteller."})
    assert run(["design", str(game), str(desc), "--takes", "1",
                "--narrator-key", "*"], FakeGenerator()) == 0
    casting = tmp_path / "my-novel-casting"
    record = json.loads((casting / "casting.json").read_text("utf-8"))
    assert record["narratorKey"] == "*"
    assert record["voices"]["narrator"]["role"] == "speaker"
    assert record["voices"]["*"]["role"] == "narrator"
    assert run(["pick", str(game), "narrator=1", "*=1"]) == 0
    result = json.loads((game / "manifest.json").read_text("utf-8"))
    assert result["voices"]["narrator"]["description"] == "A character."
    assert result["narrator"]["description"] == "The storyteller."
    assert result["voices"]["narrator"]["file"] != result["narrator"]["file"]


def test_speaker_names_that_share_a_slug_get_their_own_files(
        tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=1,
                             descriptions={"Mei": "One.", "mei": "Two."})
    record = json.loads((casting / "casting.json").read_text("utf-8"))
    files = {record["voices"][n]["takes"][0]["file"] for n in ("Mei", "mei")}
    assert files == {"mei-1.wav", "mei-2-1.wav"}


def test_design_speakers_limits_the_run(tmp_path: Path) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path)
    fake = FakeGenerator()
    assert run(["design", str(game), str(desc), "--takes", "1",
                "--speakers", "Old Theo"], fake) == 0
    assert [d for d, _, _ in fake.calls] == [DESCRIPTIONS["Old Theo"]]
    assert run(["design", str(game), str(desc), "--speakers", "Nobody"],
               FakeGenerator()) == 2


@pytest.mark.parametrize("content", [
    "[]", '{"Mei": ""}', '{"Mei": 3}', '{"": "x"}', "{not json"])
def test_design_refuses_a_bad_descriptions_file(
        tmp_path: Path, content: str) -> None:
    game = make_game(tmp_path)
    desc = tmp_path / "descriptions.json"
    desc.write_text(content, encoding="utf-8")
    assert run(["design", str(game), str(desc)], FakeGenerator()) == 2


def test_design_without_the_voice_packages_says_how_to_install(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path, {"Mei": "Bright."})
    monkeypatch.setattr(cast_voices, "VOICE_VENV", tmp_path / "no-venv")
    monkeypatch.setattr(cast_voices, "_have_voice_packages", lambda: False)
    monkeypatch.setattr(cast_voices, "_apple_silicon", lambda: True)
    assert run(["design", str(game), str(desc)]) == 1
    err = capsys.readouterr().err
    assert "requirements-voice.txt" in err
    assert not (tmp_path / "my-novel-casting" / "mei-1.wav").exists()


def test_design_needs_apple_silicon(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    desc = write_descriptions(tmp_path, {"Mei": "Bright."})
    monkeypatch.setattr(cast_voices, "_apple_silicon", lambda: False)
    assert run(["design", str(game), str(desc)]) == 1
    assert "Apple silicon" in capsys.readouterr().err


# --- pick --------------------------------------------------------------------

def test_pick_ships_the_take_and_records_the_voice(tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=2)
    old = (game / "manifest.json").read_text("utf-8")
    assert run(["pick", str(game), "Mei=2"]) == 0

    flac = game / "voices" / "mei.flac"
    assert flac_info(flac) == (24000, 1)
    assert audio_format.script_path(game, "voices/mei.flac").read_bytes() \
        == audio_format.script_bytes("voices/mei.flac", flac.read_bytes())

    new = (game / "manifest.json").read_text("utf-8")
    manifest = json.loads(new)
    assert manifest["voices"] == {"Mei": {
        "file": "voices/mei.flac", "text": PHRASE,
        "description": DESCRIPTIONS["Mei"]}}
    assert list(manifest) == ["schemaVersion", "storyId", "title", "width",
                              "height", "voices", "items"]
    block = ('  "voices": {\n    "Mei": {\n'
             '      "file": "voices/mei.flac",\n'
             f'      "text": {json.dumps(PHRASE)},\n'
             f'      "description": {json.dumps(DESCRIPTIONS["Mei"])}\n'
             '    }\n  },\n')
    assert new == old.replace('  "items"', block + '  "items"', 1)
    assert (game / "manifest.js").read_text("utf-8") \
        == f"{SHIM_PREFIX}{new.strip()};\n"
    assert validate_content.validate_folder(game) == []

    # The decoded samples are the take's.
    decoded = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(flac), "-f", "s16le", "-"],
        capture_output=True, check=True).stdout
    with wave.open(str(casting / "mei-2.wav")) as wav:
        assert decoded == wav.readframes(wav.getnframes())


def test_pick_the_narrator_and_a_second_speaker(tmp_path: Path) -> None:
    game, _ = designed(tmp_path, takes=2)
    assert run(["pick", str(game), "Mei=1"]) == 0
    old = (game / "manifest.json").read_text("utf-8")
    assert run(["pick", str(game), "narrator=2", "Old Theo=1"]) == 0
    new = (game / "manifest.json").read_text("utf-8")
    manifest = json.loads(new)
    assert manifest["narrator"] == {
        "file": "voices/narrator.flac", "text": PHRASE,
        "description": DESCRIPTIONS["narrator"]}
    assert list(manifest["voices"]) == ["Mei", "Old Theo"]
    assert manifest["voices"]["Old Theo"]["file"] == "voices/old-theo.flac"
    assert (game / "voices" / "narrator.flac.js").is_file()
    assert validate_content.validate_folder(game) == []
    only_insertions(old, new)


def test_picking_again_replaces_the_voice(tmp_path: Path) -> None:
    game, _ = designed(tmp_path, takes=2)
    assert run(["pick", str(game), "Mei=1"]) == 0
    first = (game / "voices" / "mei.flac").read_bytes()
    text = (game / "manifest.json").read_text("utf-8")
    assert run(["pick", str(game), "Mei=2"]) == 0
    assert (game / "voices" / "mei.flac").read_bytes() != first
    assert (game / "manifest.json").read_text("utf-8") == text
    assert validate_content.validate_folder(game) == []


def test_pick_keeps_a_hand_formatted_manifest_byte_stable(
        tmp_path: Path) -> None:
    text = ('{ "schemaVersion":1,\n'
            '\t"storyId" : "hand",   "width":64, "height":36,\n'
            '\t"items":[ {"id":"p","type":"image","file":"first.png"},\n'
            '\t\t{"id":"a","type":"text","speaker":"Mei",'
            '"text":"Café at noon."} ]\n'
            '}\n')
    game = make_game(tmp_path, text=text)
    desc = write_descriptions(tmp_path, {"Mei": "Bright."})
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    assert run(["pick", str(game), "Mei=1"]) == 0
    new = (game / "manifest.json").read_text("utf-8")
    single_insertion(text, new)
    assert json.loads(new)["voices"]["Mei"]["file"] == "voices/mei.flac"
    assert validate_content.validate_folder(game) == []


def test_pick_keeps_ascii_escapes_when_the_manifest_uses_them(
        tmp_path: Path) -> None:
    manifest = {"schemaVersion": 1, "storyId": "s", "width": 64,
                "height": 36, "items": [PICTURE,
                    {"id": "a", "type": "text", "speaker": "Zoë",
                     "text": "Hi."}]}
    game = make_game(tmp_path, manifest)  # json.dumps escapes by default
    desc = write_descriptions(tmp_path, {"Zoë": "Soft — low."})
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    assert run(["pick", str(game), "Zoë=1"]) == 0
    new = (game / "manifest.json").read_text("utf-8")
    assert new.isascii()
    assert json.loads(new)["voices"]["Zoë"]["file"] == "voices/zoe.flac"


def test_pick_does_not_take_a_file_another_voice_uses(tmp_path: Path) -> None:
    manifest = {"schemaVersion": 1, "storyId": "s", "width": 64,
                "height": 36,
                "voices": {"MEI": {"file": "voices/mei.flac"}},
                "items": [PICTURE,
                    {"id": "a", "type": "text", "speaker": "Mei",
                     "text": "Hi."},
                    {"id": "b", "type": "text", "speaker": "MEI",
                     "text": "HI."}]}
    game = make_game(tmp_path, manifest)
    (game / "voices").mkdir()
    synthetic_wav(game / "voices" / "mei.flac", 1)  # any audio bytes
    audio_format.write_script(game, "voices/mei.flac")
    before = (game / "voices" / "mei.flac").read_bytes()
    desc = write_descriptions(tmp_path, {"Mei": "Bright."})
    assert run(["design", str(game), str(desc), "--takes", "1"],
               FakeGenerator()) == 0
    assert run(["pick", str(game), "Mei=1"]) == 0
    result = json.loads((game / "manifest.json").read_text("utf-8"))
    assert result["voices"]["Mei"]["file"] == "voices/mei-2.flac"
    assert (game / "voices" / "mei.flac").read_bytes() == before


def test_pick_leaves_a_folder_without_a_shim_without_one(
        tmp_path: Path) -> None:
    game, _ = designed(tmp_path, takes=1)
    (game / "manifest.js").unlink()
    assert run(["pick", str(game), "Mei=1"]) == 0
    assert not (game / "manifest.js").exists()


@pytest.mark.parametrize("arg", ["Mei", "Mei=", "Mei=x", "Mei=0", "=1",
                                 "Mei=-1"])
def test_pick_refuses_a_bad_argument(tmp_path: Path, arg: str) -> None:
    game, _ = designed(tmp_path, takes=2)
    before = (game / "manifest.json").read_bytes()
    assert run(["pick", str(game), arg]) == 2
    assert (game / "manifest.json").read_bytes() == before
    assert not (game / "voices").exists()


@pytest.mark.parametrize("arg", ["Nobody=1", "Mei=3"])
def test_pick_refuses_an_unknown_voice_or_take(
        tmp_path: Path, arg: str, capsys: pytest.CaptureFixture[str]) -> None:
    game, _ = designed(tmp_path, takes=2)
    before = (game / "manifest.json").read_bytes()
    assert run(["pick", str(game), "Old Theo=1", arg]) == 1
    assert arg.split("=")[0] in capsys.readouterr().err
    assert (game / "manifest.json").read_bytes() == before
    assert not (game / "voices").exists()


def test_pick_without_a_casting_folder(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    assert run(["pick", str(game), "Mei=1"]) == 1
    assert "casting" in capsys.readouterr().err
    assert run(["pick", str(game), "Mei=1", "--casting",
                str(tmp_path / "nowhere")]) == 1


def test_pick_reads_a_moved_casting_folder(tmp_path: Path) -> None:
    game, casting = designed(tmp_path, takes=1)
    moved = tmp_path / "moved"
    casting.rename(moved)
    assert run(["pick", str(game), "Mei=1", "--casting", str(moved)]) == 0


# --- record ------------------------------------------------------------------

def test_record_uses_the_authors_clip(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    clip = synthetic_wav(tmp_path / "me.wav", 6, rate=22050, channels=2)
    assert run(["record", str(game), "Old Theo=" + str(clip),
                "--text", "Six seconds of me."]) == 0
    flac = game / "voices" / "old-theo.flac"
    assert flac_info(flac) == (22050, 1)
    manifest = json.loads((game / "manifest.json").read_text("utf-8"))
    assert manifest["voices"]["Old Theo"] == {
        "file": "voices/old-theo.flac", "text": "Six seconds of me."}
    assert validate_content.validate_folder(game) == []
    assert "seconds" not in capsys.readouterr().err


def test_record_caps_the_rate_at_48k_and_can_be_the_narrator(
        tmp_path: Path) -> None:
    game = make_game(tmp_path)
    clip = synthetic_wav(tmp_path / "hi.wav", 6, rate=96000, channels=1)
    assert run(["record", str(game), f"narrator={clip}"]) == 0
    manifest = json.loads((game / "manifest.json").read_text("utf-8"))
    assert manifest["narrator"] == {"file": "voices/narrator.flac"}
    assert flac_info(game / "voices" / "narrator.flac") == (48000, 1)


@pytest.mark.parametrize("seconds,word", [(2, "shorter"), (21, "longer")])
def test_record_warns_about_a_clip_too_short_or_long(
        tmp_path: Path, seconds: float, word: str,
        capsys: pytest.CaptureFixture[str]) -> None:
    game = make_game(tmp_path)
    clip = synthetic_wav(tmp_path / "x.wav", seconds, rate=16000, channels=1)
    assert run(["record", str(game), f"Mei={clip}"]) == 0
    assert word in capsys.readouterr().err


@pytest.mark.parametrize("arg", ["Mei", "=x.wav", "Mei="])
def test_record_refuses_a_bad_argument(tmp_path: Path, arg: str) -> None:
    game = make_game(tmp_path)
    assert run(["record", str(game), arg]) == 2


def test_record_refuses_a_missing_or_unreadable_clip(tmp_path: Path) -> None:
    game = make_game(tmp_path)
    before = (game / "manifest.json").read_bytes()
    assert run(["record", str(game), f"Mei={tmp_path / 'none.wav'}"]) == 1
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"not audio at all")
    assert run(["record", str(game), f"Mei={junk}"]) == 1
    assert (game / "manifest.json").read_bytes() == before


def test_a_folder_without_a_manifest_is_refused(tmp_path: Path) -> None:
    folder = tmp_path / "empty"
    folder.mkdir()
    clip = synthetic_wav(tmp_path / "me.wav", 6)
    assert run(["record", str(folder), f"Mei={clip}"]) == 2
    desc = write_descriptions(tmp_path)
    assert run(["design", str(folder), str(desc)], FakeGenerator()) == 2


# --- the command line --------------------------------------------------------

def test_version() -> None:
    proc = subprocess.run([sys.executable, str(TOOLS_DIR / "cast_voices.py"),
                           "--version"], capture_output=True, text=True,
                          check=False)
    assert proc.returncode == 0
    assert proc.stdout == f"Kinetic {kinetic_version()}\n"


def test_help_names_the_commands() -> None:
    proc = subprocess.run([sys.executable, str(TOOLS_DIR / "cast_voices.py"),
                           "--help"], capture_output=True, text=True,
                          check=False, env={**os.environ})
    assert proc.returncode == 0
    for word in ("design", "pick", "record"):
        assert word in proc.stdout
