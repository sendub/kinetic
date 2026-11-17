"""The pieces with no process around them: cache keys, the job queue,
wheel choice, the WAV writer and the real lock file's shape."""

from __future__ import annotations

import io
import json
import re
import wave

import pytest
from conftest import VOICE_DIR
from kinetic_voice.cache import line_key
from kinetic_voice.engine import pcm_to_wav
from kinetic_voice.install import Lock
from kinetic_voice.jobs import JobQueue

IDENTITY = {"engine": "chatterbox-mlx", "model": {"repo": "rev1"},
            "settings": {"cfgWeight": 0.5}}


def test_line_key_is_stable_and_hex():
    key = line_key(IDENTITY, "v" * 64, "Hello.", "en")
    assert key == line_key(dict(IDENTITY), "v" * 64, "Hello.", "en")
    assert re.fullmatch(r"[0-9a-f]{64}", key)


@pytest.mark.parametrize("change", [
    {"identity": {**IDENTITY, "engine": "chatterbox-torch"}},
    {"identity": {**IDENTITY, "model": {"repo": "rev2"}}},
    {"identity": {**IDENTITY, "settings": {"cfgWeight": 0.6}}},
    {"voice": "w" * 64},
    {"text": "Hello!"},
    {"lang": "fr"},
])
def test_line_key_changes_with_every_input(change):
    args = {"identity": IDENTITY, "voice": "v" * 64, "text": "Hello.",
            "lang": "en", **change}
    base = line_key(IDENTITY, "v" * 64, "Hello.", "en")
    assert line_key(args["identity"], args["voice"], args["text"],
                    args["lang"]) != base


def test_queue_orders_by_priority_then_arrival():
    q = JobQueue()
    for name, prio in [("a", 0), ("b", 3), ("c", 3), ("d", 1), ("e", 0)]:
        q.put(name, name, prio)
    assert [q.get()[1] for _ in range(5)] == ["b", "c", "d", "a", "e"]


def test_control_jobs_come_before_any_speak():
    q = JobQueue()
    q.put("s", "speak", 100)
    q.put("c", "control", 0, control=True)
    assert q.get()[1] == "control"


def test_cancel_removes_a_queued_job():
    q = JobQueue()
    q.put(1, "one", 0)
    q.put(2, "two", 0)
    assert q.cancel(1) == "one"  # the dropped job
    assert q.state(1) == "unknown"
    assert q.get()[1] == "two"


def test_cancel_reports_running_and_done():
    q = JobQueue()
    q.put(1, "one", 0)
    rid, _ = q.get()
    assert q.cancel(rid) is None
    assert q.state(rid) == "running"
    q.done(rid)
    assert q.state(rid) == "done"


def test_pcm_to_wav_writes_24khz_16bit_mono():
    pcm = b"\x01\x00\xff\xff" * 12000
    data = pcm_to_wav(pcm, 24000)
    with wave.open(io.BytesIO(data)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(),
                w.getnframes()) == (1, 2, 24000, 24000)
        assert w.readframes(24000) == pcm


def wheel(name, mac=None, size=1):
    entry = {"name": name, "url": f"https://x/{name}-{mac}.whl",
             "sha256": "0" * 64, "size": size}
    if mac:
        entry["minMacos"] = mac
    return entry


def test_wheel_choice_takes_the_newest_build_the_system_runs():
    lock = Lock({"id": "t", "wheels": [
        wheel("mlx", "14.0"), wheel("mlx", "15.0"), wheel("mlx", "26.0"),
        wheel("numpy")], "model": [], "engine": {}})
    assert [w["url"] for w in lock.wheels("15.4")] == [
        "https://x/mlx-15.0.whl", "https://x/numpy-None.whl"]
    assert [w["url"] for w in lock.wheels("27.2.1")][0] == (
        "https://x/mlx-26.0.whl")
    with pytest.raises(ValueError, match="macOS 14.0"):
        lock.wheels("13.6")


def test_real_lock_is_complete():
    data = json.loads((VOICE_DIR / "lock-macos-arm64.json").read_text())
    assert re.fullmatch(r"macos-arm64-\d+", data["id"])
    py = data["python"]
    assert py["url"].startswith(
        "https://github.com/astral-sh/python-build-standalone/releases/")
    assert py["size"] == 25_371_130
    assert re.fullmatch(r"[0-9a-f]{64}", py["sha256"])
    names = {w["name"] for w in data["wheels"]}
    assert {"mlx-audio", "mlx", "mlx-metal", "numpy"} <= names
    for w in data["wheels"]:
        assert w["url"].startswith("https://files.pythonhosted.org/")
        assert w["url"].endswith(".whl")
        assert re.fullmatch(r"[0-9a-f]{64}", w["sha256"])
        assert w["size"] > 0
    repos = {m["repo"] for m in data["model"]}
    assert repos == {"mlx-community/chatterbox-multilingual-v3",
                     "mlx-community/S3TokenizerV2"}
    for m in data["model"]:
        assert re.fullmatch(r"[0-9a-f]{40}", m["revision"])
        assert re.fullmatch(r"[0-9a-f]{64}", m["sha256"])
    assert data["engine"]["id"] == "chatterbox-mlx"
    # Every Mac that runs mlx gets one build of each package.
    for mac in ("14.0", "15.0", "26.0"):
        chosen = Lock(data).wheels(mac)
        assert len({w["name"] for w in chosen}) == len(chosen) == len(names)


def test_real_lock_engine_settings():
    engine = json.loads((VOICE_DIR / "lock-macos-arm64.json").read_text())[
        "engine"]
    assert set(engine) == {
        "id", "repo", "quantizeBits", "quantizeGroupSize", "cfgWeight",
        "exaggeration", "temperature", "minP", "repetitionPenalty",
        "maxTokens", "flowSteps", "promptSeconds", "stream"}
    assert 1 <= engine["flowSteps"] < 10
    assert 0 < engine["promptSeconds"] <= 10
    assert set(engine["stream"]) == {"firstSeconds", "chunkSeconds",
                                     "growth", "limitSeconds",
                                     "contextSeconds"}
    assert 0 < engine["stream"]["firstSeconds"] <= engine["stream"][
        "limitSeconds"]


# The engine's languages (docs/plan.md Phase 56 item 6).

def test_engine_languages_are_chatterbox_multilingual_s():
    from kinetic_voice.engine import LANGUAGES
    assert LANGUAGES == ("ar", "da", "de", "el", "en", "es", "fi", "fr",
                         "he", "hi", "it", "ja", "ko", "ms", "nl", "no",
                         "pl", "pt", "ru", "sv", "sw", "tr", "zh")


@pytest.mark.parametrize(("tag", "code"), [
    ("de", "de"), ("de-AT", "de"), ("en-GB", "en"), ("ja", "ja"),
    ("ar", "ar"), ("nb", "no"), ("nn", "no"), ("no", "no"),
    ("zh-Hans", "zh"), ("zh-Hant", "zh"), ("pt-BR", "pt"), ("pt-PT", "pt"),
    ("es-419", "es"), ("he", "he"), ("sw", "sw"),
    ("vi", None), ("uk", None), ("fa", None), ("ur", None), ("th", None),
    ("ca", None), ("id", None),
])
def test_engine_language_by_primary_subtag(tag, code):
    from kinetic_voice.engine import engine_language
    assert engine_language(tag) == code


def test_the_player_keeps_the_same_languages():
    """player/src/render/linevoice.ts holds the list the page checks
    before it asks for a line; it must be this one."""
    from kinetic_voice.engine import LANGUAGES
    source = (VOICE_DIR.parent.parent / "player" / "src" / "render"
              / "linevoice.ts").read_text(encoding="utf-8")
    found = re.search(r"ENGINE_LANGUAGES[^=]*=\s*\[([^\]]*)\]", source)
    assert found is not None, "linevoice.ts has no ENGINE_LANGUAGES list"
    assert tuple(re.findall(r'"([a-z]+)"', found.group(1))) == LANGUAGES
    aliases = re.search(r"ENGINE_ALIASES[^=]*=\s*\{([^}]*)\}", source)
    assert aliases is not None
    assert dict(re.findall(r'(\w+):\s*"([a-z]+)"', aliases.group(1))) == {
        "nb": "no", "nn": "no"}
