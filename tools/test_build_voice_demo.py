"""Tests for fixtures/build_voice_demo.py. Run with:

    .venv/bin/pytest tools/test_build_voice_demo.py -q

fixtures/voice-demo is gitignored, so these tests always build from
scratch into temporary folders. The reference clips under
fixtures/voices/ are committed inputs.
"""

from __future__ import annotations

import base64
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

TOOLS_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOLS_DIR.parent
BUILD_VOICE_DEMO = REPO_ROOT / "fixtures" / "build_voice_demo.py"
VOICES_DIR = REPO_ROOT / "fixtures" / "voices"

if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from cast_voices import PHRASE  # noqa: E402

# The research's test scene (docs/voice-reading.md), word for word.
EXCHANGE = [
    ("Wren", "Hello? Is anyone home? I didn't think anybody still lived "
             "out here."),
    ("Helen", "Forty years this spring. You'd better come inside before "
              "the storm does."),
    ("Wren", "I'm so sorry to barge in. My car died two miles back, and my "
             "phone's completely useless."),
    ("Helen", "Phones usually are, out here. Sit by the fire, love. The "
              "kettle's already on."),
    ("Wren", "Wait... the kettle's on? Were you expecting someone tonight?"),
    ("Helen", "Not someone. You. Your grandmother always said you'd find "
              "your way here, one day."),
]

DESCRIPTIONS = {
    "Wren": "A young American woman in her twenties with a bright, quick, "
            "friendly voice.",
    "Helen": "An older British woman in her sixties with a warm, low, "
             "unhurried voice.",
}

SCRIPT = re.compile(rb'__kineticAudio\("([^"\\]*)","([A-Za-z0-9+/]*={0,2})"'
                    rb'\);\n')


def build(out: Path, env: dict[str, str] | None = None
          ) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BUILD_VOICE_DEMO), "--out", str(out)],
        cwd=REPO_ROOT, capture_output=True, text=True, env=env)


@pytest.fixture(scope="module")
def built(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("first") / "voice-demo"
    proc = build(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return out


@pytest.fixture(scope="module")
def manifest(built: Path) -> dict:
    return json.loads((built / "manifest.json").read_text(encoding="utf-8"))


def lines(manifest: dict) -> list[dict]:
    """The items that show text, in order."""
    return [item for item in manifest["items"] if item.get("text")]


def all_files(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def flac_format(data: bytes) -> tuple[int, int]:
    """(sample rate, channels) from a FLAC file's STREAMINFO block."""
    assert data[:4] == b"fLaC"
    assert data[4] & 0x7F == 0  # the first metadata block is STREAMINFO
    info = data[8:8 + 34]
    packed = int.from_bytes(info[10:13], "big")
    return packed >> 4, ((packed >> 1) & 0x7) + 1


def test_validator_reports_no_problems_or_warnings(built: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(TOOLS_DIR / "validate_content.py"), str(built)],
        cwd=REPO_ROOT, capture_output=True, text=True)
    assert (proc.returncode, proc.stdout, proc.stderr) == (0, "", "")


def test_two_builds_are_byte_identical(built: Path, tmp_path: Path) -> None:
    again = tmp_path / "voice-demo"
    proc = build(again)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    first, second = all_files(built), all_files(again)
    assert sorted(first) == sorted(second)
    assert [name for name in first if first[name] != second[name]] == []


def test_a_rebuild_over_its_own_output_works(built: Path,
                                             tmp_path: Path) -> None:
    out = tmp_path / "voice-demo"
    assert build(out).returncode == 0
    proc = build(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert all_files(out) == all_files(built)


def test_a_folder_with_other_subfolders_is_refused(tmp_path: Path) -> None:
    out = tmp_path / "voice-demo"
    (out / "keep").mkdir(parents=True)
    (out / "keep" / "precious.txt").write_text("mine")
    proc = build(out)
    assert proc.returncode != 0
    assert "not deleting it" in proc.stderr
    assert (out / "keep" / "precious.txt").read_text() == "mine"


def test_builds_with_no_ffmpeg_on_path(tmp_path: Path) -> None:
    """The committed clips are inputs: the builder needs the repo venv
    only, not PATH's ffmpeg."""
    proc = build(tmp_path / "voice-demo", env={"PATH": "/nonexistent"})
    assert proc.returncode == 0, proc.stdout + proc.stderr


def test_title_story_id_and_no_audio_section(manifest: dict) -> None:
    assert manifest["title"] == "Voice demo"
    assert manifest["storyId"] == "kinetic-voice-demo"
    assert "audio" not in manifest
    assert not any("audio" in item for item in manifest["items"])


def test_between_15_and_25_lines(manifest: dict) -> None:
    assert 15 <= len(lines(manifest)) <= 25


def test_the_exchange_is_present_in_order(manifest: dict) -> None:
    said = [(item.get("speaker"), item["text"]) for item in lines(manifest)]
    start = said.index(EXCHANGE[0])
    assert said[start:start + len(EXCHANGE)] == EXCHANGE


def test_narration_before_between_and_after_the_exchange(
        manifest: dict) -> None:
    said = [(item.get("speaker"), item["text"]) for item in lines(manifest)]
    start = said.index(EXCHANGE[0])
    end = start + len(EXCHANGE)
    narrated = [i for i, item in enumerate(lines(manifest))
                if not item.get("speaker")]
    assert any(i < start for i in narrated)
    assert any(i >= end for i in narrated)
    # Narration also separates other speakers' lines after the exchange.
    assert any(end <= i < len(said) - 1 for i in narrated)


def test_voices_and_narrator(manifest: dict) -> None:
    voices = manifest["voices"]
    assert set(voices) == {"Wren", "Helen"}
    for name, voice in voices.items():
        assert voice == {"file": f"voices/{name.lower()}.flac",
                         "text": PHRASE,
                         "description": DESCRIPTIONS[name]}
    narrator = manifest["narrator"]
    assert narrator["file"] == "voices/narrator.flac"
    assert narrator["text"] == PHRASE
    assert "narrator" in narrator["description"]


def test_every_voice_file_and_script_is_there(built: Path,
                                              manifest: dict) -> None:
    for voice in [*manifest["voices"].values(), manifest["narrator"]]:
        file = voice["file"]
        data = (built / file).read_bytes()
        assert data == (VOICES_DIR / Path(file).name).read_bytes(), file
        found = SCRIPT.fullmatch((built / f"{file}.js").read_bytes())
        assert found is not None, file
        assert found.group(1).decode() == file
        assert base64.b64decode(found.group(2), validate=True) == data


@pytest.mark.parametrize("name", ["wren", "helen", "narrator"])
def test_committed_clips_are_24k_mono_flac(name: str) -> None:
    data = (VOICES_DIR / f"{name}.flac").read_bytes()
    assert flac_format(data) == (24000, 1)


def test_a_voiceless_speaker_has_a_line(manifest: dict) -> None:
    voiced = set(manifest["voices"])
    speakers = {item["speaker"] for item in lines(manifest)
                if item.get("speaker")}
    assert speakers - voiced == {"Radio"}


def test_wren_has_one_thought(manifest: dict) -> None:
    thoughts = [item for item in manifest["items"] if item.get("thought")]
    assert [item["speaker"] for item in thoughts] == ["Wren"]
