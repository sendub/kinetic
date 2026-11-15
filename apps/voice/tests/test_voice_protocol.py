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
