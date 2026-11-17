"""The helper's JSON-lines protocol, against the fake engine."""

from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from conftest import VOICE_DIR, b64, make_wav, read_wav


def test_status_before_install(start_helper):
    helper = start_helper()
    status = helper.request("status")
    assert status["ok"] is True
    assert status["installed"] is False
    assert status["engine"] == "fake"
    assert status["warm"] is False
    assert status["lock"].startswith("macos-arm64-")
    assert status["downloadBytes"] > 3_000_000_000
    assert status["installedBytes"] == 0


def test_voice_returns_the_reference_hash(start_helper):
    helper = start_helper()
    ref = make_wav()
    reply = helper.request("voice", voice=b64(ref), format="wav",
                           text="A synthetic transcript.")
    assert reply == {"id": reply["id"], "ok": True,
                     "voiceId": hashlib.sha256(ref).hexdigest()}


def test_speak_returns_24khz_16bit_mono_wav(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    reply = helper.request("speak", voiceId=voice["voiceId"],
                           text="A short synthetic line.")
    assert reply["ok"] is True
    assert reply["cached"] is False
    wav = base64.b64decode(reply["wav"])
    channels, width, rate, frames = read_wav(wav)
    assert (channels, width, rate) == (1, 2, 24000)
    assert abs(frames / rate - reply["seconds"]) < 0.01
    assert reply["seconds"] > 0
    assert reply["genSeconds"] >= 0


def test_longer_text_gives_longer_audio(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    short = helper.request("speak", voiceId=voice["voiceId"], text="Hi.")
    long = helper.request("speak", voiceId=voice["voiceId"],
                          text="A much longer synthetic line of text.")
    assert long["seconds"] > short["seconds"]


def test_second_speak_of_the_same_line_is_a_cache_hit(start_helper):
    helper = start_helper("--fake-delay", "0.3")
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    first = helper.request("speak", voiceId=voice["voiceId"],
                           text="Cached line.")
    again = helper.request("speak", voiceId=voice["voiceId"],
                           text="Cached line.")
    other = helper.request("speak", voiceId=voice["voiceId"],
                           text="Another line.")
    assert first["cached"] is False
    assert again["cached"] is True
    assert again["wav"] == first["wav"]
    assert again["genSeconds"] == 0
    assert other["cached"] is False


def test_cache_survives_a_restart(start_helper, tmp_path):
    root = tmp_path / "voice"
    helper = start_helper(root=root)
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    first = helper.request("speak", voiceId=voice["voiceId"], text="Kept.")
    helper.request("quit")
    helper.proc.wait(timeout=10)
    again = start_helper(root=root).request(
        "speak", voiceId=voice["voiceId"], text="Kept.")
    assert again["cached"] is True
    assert again["wav"] == first["wav"]


def test_a_voice_registered_earlier_is_known_after_a_restart(start_helper,
                                                             tmp_path):
    root = tmp_path / "voice"
    helper = start_helper(root=root)
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    helper.request("quit")
    helper.proc.wait(timeout=10)
    reply = start_helper(root=root).request(
        "speak", voiceId=voice["voiceId"], text="New line, old voice.")
    assert reply["ok"] is True
    assert reply["cached"] is False


def test_unknown_voice(start_helper):
    reply = start_helper().request("speak", voiceId="0" * 64, text="Hello.")
    assert reply["ok"] is False
    assert reply["code"] == "unknown-voice"


def test_unsupported_reference_format(start_helper):
    reply = start_helper().request("voice", voice=b64(b"x"), format="ogg")
    assert reply["ok"] is False
    assert reply["code"] == "bad-request"


def test_speak_without_text(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    reply = helper.request("speak", voiceId=voice["voiceId"], text="  ")
    assert reply["ok"] is False
    assert reply["code"] == "bad-request"


def test_priority_queue_serves_highest_first_then_fifo(start_helper):
    helper = start_helper("--fake-delay", "0.4")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    busy = helper.send("speak", voiceId=vid, text="Busy line.")
    helper.wait_event(lambda e: e.get("message") == "speaking"
                      and e.get("target") == busy)
    low = helper.send("speak", voiceId=vid, text="Low line.")
    high1 = helper.send("speak", voiceId=vid, text="High one.", priority=5)
    high2 = helper.send("speak", voiceId=vid, text="High two.", priority=5)
    mid = helper.send("speak", voiceId=vid, text="Middle.", priority=2)
    for rid in (busy, low, high1, high2, mid):
        assert helper.wait(rid)["ok"] is True
    speaks = [r for r in helper.order if r in (busy, low, high1, high2, mid)]
    assert speaks == [busy, high1, high2, mid, low]


def test_cancel_drops_a_queued_speak(start_helper):
    helper = start_helper("--fake-delay", "0.4")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    busy = helper.send("speak", voiceId=vid, text="Busy line.")
    queued = helper.send("speak", voiceId=vid, text="Dropped line.")
    cancel = helper.request("cancel", target=queued)
    assert cancel["ok"] is True
    assert cancel["cancelled"] is True
    dropped = helper.wait(queued)
    assert dropped["ok"] is False
    assert dropped["code"] == "cancelled"
    assert helper.wait(busy)["ok"] is True


def test_cancel_of_a_finished_speak_says_so(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    done = helper.send("speak", voiceId=vid, text="Done line.")
    helper.wait(done)
    cancel = helper.request("cancel", target=done)
    assert cancel["ok"] is True
    assert cancel["cancelled"] is False


def test_cancel_of_a_running_speak_reports_running(start_helper):
    helper = start_helper("--fake-delay", "0.5")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    running = helper.send("speak", voiceId=vid, text="Running line.")
    helper.wait_event(lambda e: e.get("event") == "log"
                      and e.get("message") == "speaking"
                      and e.get("target") == running)
    cancel = helper.request("cancel", target=running)
    assert cancel == {"id": cancel["id"], "ok": True, "cancelled": False,
                      "state": "running"}
    assert helper.wait(running)["ok"] is True


def test_requests_are_answered_while_a_line_is_generated(start_helper):
    helper = start_helper("--fake-delay", "1.0")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    slow = helper.send("speak", voiceId=vid, text="Slow line.")
    status = helper.request("status", timeout=0.8)
    assert status["ok"] is True
    assert slow not in helper.responses


def test_warm_loads_the_engine(start_helper):
    helper = start_helper()
    assert helper.request("warm")["ok"] is True
    assert helper.request("status")["warm"] is True


def test_malformed_line(start_helper):
    helper = start_helper()
    helper.send_raw("this is not json")
    reply = helper.wait(None)
    assert reply["ok"] is False
    assert reply["code"] == "bad-request"
    assert helper.request("status")["ok"] is True


def test_request_without_op(start_helper):
    helper = start_helper()
    helper.send_raw(json.dumps({"id": 7}))
    reply = helper.wait(7)
    assert reply["ok"] is False
    assert reply["code"] == "bad-request"


def test_unknown_op(start_helper):
    reply = start_helper().request("dance")
    assert reply["ok"] is False
    assert reply["code"] == "unknown-op"
    assert "dance" in reply["error"]


def test_string_ids_are_echoed(start_helper):
    reply = start_helper().request("status", id="abc")
    assert reply["id"] == "abc"


def test_quit_exits_cleanly(start_helper):
    helper = start_helper()
    assert helper.request("quit")["ok"] is True
    assert helper.proc.wait(timeout=10) == 0


def test_end_of_input_exits_cleanly(start_helper):
    helper = start_helper()
    assert helper.proc.stdin is not None
    helper.proc.stdin.close()
    assert helper.proc.wait(timeout=10) == 0


def test_library_prints_do_not_reach_the_protocol(start_helper):
    # The fake engine prints on load, as mlx_audio does: stdout must carry
    # only protocol lines.
    helper = start_helper()
    helper.request("warm")
    helper.request("quit")
    helper.proc.wait(timeout=10)
    assert b"fake engine loaded" in helper.stderr


def test_runs_as_a_module(tmp_path):
    proc = subprocess.run(
        [sys.executable, "-m", "kinetic_voice", "--root",
         str(tmp_path / "v"), "--engine", "fake"],
        input=b'{"id": 1, "op": "quit"}\n', capture_output=True,
        cwd=VOICE_DIR, timeout=30)
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == {"id": 1, "ok": True}


def test_nothing_is_written_outside_the_voice_folder(start_helper, tmp_path):
    root = tmp_path / "voice"
    helper = start_helper(root=root)
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    helper.request("speak", voiceId=vid, text="Inside.")
    helper.request("quit")
    helper.proc.wait(timeout=10)
    outside = [p for p in tmp_path.iterdir() if p != root]
    assert outside == []
    assert sorted(p.name for p in root.iterdir()) == ["cache"]
    assert Path(root, "cache").is_dir()


# Streaming: "stream": true on speak sends chunk events before the reply.

def _pcm(wav_b64: str) -> bytes:
    import io
    import wave
    with wave.open(io.BytesIO(base64.b64decode(wav_b64)), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (
            1, 2, 24000)
        return w.readframes(w.getnframes())


def _chunks(helper, rid):
    return [e for e in helper.events
            if e.get("event") == "chunk" and e.get("target") == rid]


def test_a_streamed_line_comes_in_chunks_then_the_whole_reply(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    text = "A streamed synthetic line, long enough for several chunks."
    rid = helper.send("speak", voiceId=vid, text=text, stream=True)
    reply = helper.wait(rid)
    assert reply["ok"] is True
    assert reply["cached"] is False
    chunks = _chunks(helper, rid)
    assert len(chunks) >= 2
    assert [c["index"] for c in chunks] == list(range(len(chunks)))
    assert [c["final"] for c in chunks] == [False] * (len(chunks) - 1) + [
        True]
    for c in chunks:
        pcm = _pcm(c["wav"])
        assert abs(len(pcm) / 2 / 24000 - c["seconds"]) < 0.01
    # The reply is the whole line: the chunks joined, as the cache keeps it.
    assert _pcm(reply["wav"]) == b"".join(_pcm(c["wav"]) for c in chunks)
    assert abs(sum(c["seconds"] for c in chunks) - reply["seconds"]) < 0.01
    assert reply["firstSeconds"] <= reply["genSeconds"]


def test_chunk_events_come_before_the_reply(start_helper):
    helper = start_helper("--fake-delay", "1.0")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    rid = helper.send("speak", voiceId=vid, stream=True,
                      text="A slow streamed line with a few chunks in it.")
    first = helper.wait_event(lambda e: e.get("event") == "chunk"
                              and e.get("target") == rid)
    assert first["index"] == 0
    assert first["final"] is False
    assert rid not in helper.responses  # the line is still being made
    assert helper.wait(rid)["ok"] is True


def test_a_cached_line_answers_a_stream_with_just_the_reply(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    text = "Streamed once, then cached."
    first = helper.request("speak", voiceId=vid, text=text, stream=True)
    again_id = helper.send("speak", voiceId=vid, text=text, stream=True)
    again = helper.wait(again_id)
    assert again["cached"] is True
    assert again["wav"] == first["wav"]
    assert _chunks(helper, again_id) == []


def test_a_streamed_line_is_cached_for_a_plain_speak(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    text = "Streamed, then asked for whole."
    streamed = helper.request("speak", voiceId=vid, text=text, stream=True)
    plain = helper.request("speak", voiceId=vid, text=text)
    assert plain["cached"] is True
    assert plain["wav"] == streamed["wav"]


def test_a_plain_speak_sends_no_chunks(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    rid = helper.send("speak", voiceId=vid,
                      text="A plain synthetic line with no stream.")
    reply = helper.wait(rid)
    assert reply["ok"] is True
    assert "firstSeconds" not in reply
    assert _chunks(helper, rid) == []


def test_stream_must_be_a_boolean(start_helper):
    helper = start_helper()
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    reply = helper.request("speak", voiceId=vid, text="Hello.", stream="yes")
    assert reply["ok"] is False
    assert reply["code"] == "bad-request"


def test_a_queued_streamed_line_can_be_cancelled(start_helper):
    helper = start_helper("--fake-delay", "0.4")
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    busy = helper.send("speak", voiceId=vid, text="Busy line.", stream=True)
    queued = helper.send("speak", voiceId=vid, text="Dropped streamed line.",
                         stream=True)
    assert helper.request("cancel", target=queued)["cancelled"] is True
    assert helper.wait(queued)["code"] == "cancelled"
    assert helper.wait(busy)["ok"] is True
    assert _chunks(helper, queued) == []


# Languages (docs/plan.md Phase 56 item 6): `speak` takes the engine's
# language id, which reaches the engine and the cache key.

def _pitch_crossings(wav: bytes) -> int:
    """How often the fake engine's tone crosses zero: its pitch."""
    import array
    import io
    import wave as wavelib
    with wavelib.open(io.BytesIO(wav), "rb") as w:
        samples = array.array("h", w.readframes(w.getnframes()))
    return sum(1 for a, b in zip(samples, samples[1:]) if a < 0 <= b)


def test_lang_reaches_the_engine_and_keys_the_cache(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    english = helper.request("speak", voiceId=voice["voiceId"],
                             text="Hallo.")
    german = helper.request("speak", voiceId=voice["voiceId"],
                            text="Hallo.", lang="de")
    german_again = helper.request("speak", voiceId=voice["voiceId"],
                                  text="Hallo.", lang="de")
    english_again = helper.request("speak", voiceId=voice["voiceId"],
                                   text="Hallo.", lang="en")
    # Not the English line from the cache: the engine made it in German
    # (the fake engine's pitch follows the language).
    assert german["cached"] is False
    assert german["wav"] != english["wav"]
    assert _pitch_crossings(base64.b64decode(german["wav"])) > \
        _pitch_crossings(base64.b64decode(english["wav"]))
    assert german_again["cached"] is True
    assert german_again["wav"] == german["wav"]
    assert english_again["cached"] is True  # `en` is the default
    assert english_again["wav"] == english["wav"]
    speaking = [e for e in helper.events
                if e.get("event") == "log" and e.get("message") == "speaking"]
    assert [e["lang"] for e in speaking] == ["en", "de"]


def test_a_streamed_line_speaks_its_lang(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    whole = helper.request("speak", voiceId=voice["voiceId"],
                           text="Bonjour à tous.", lang="fr")
    other = helper.request("speak", voiceId=voice["voiceId"],
                           text="Bonjour à tous!", lang="fr", stream=True)
    plain = helper.request("speak", voiceId=voice["voiceId"],
                           text="Bonjour à tous!", stream=True)
    assert whole["cached"] is False and other["cached"] is False
    assert plain["cached"] is False
    assert _pitch_crossings(base64.b64decode(other["wav"])) > \
        _pitch_crossings(base64.b64decode(plain["wav"]))


def test_a_lang_the_engine_lacks_is_refused(start_helper):
    helper = start_helper()
    voice = helper.request("voice", voice=b64(make_wav()), format="wav")
    for lang in ("vi", "de-DE", "DE", ""):
        reply = helper.request("speak", voiceId=voice["voiceId"],
                               text="Xin chào.", lang=lang)
        assert reply["ok"] is False
        assert reply["code"] == "bad-request"
