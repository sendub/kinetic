"""install, status and remove against a local file server.

The wheels are tiny real wheels that pip installs into ``lib/``; the
model files are random bytes.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from conftest import build_wheel, write_lock

MODEL = {
    ("test-org/main-model", "model.safetensors"): os.urandom(300_000),
    ("test-org/main-model", "config.json"): b'{"model_type": "test"}',
    ("test-org/tokenizer", "model.safetensors"): os.urandom(50_000),
}


@pytest.fixture
def lock(tmp_path, file_server):
    wheels = tmp_path / "built"
    wheels.mkdir()
    built = [build_wheel(wheels, "alpha"), build_wheel(wheels, "beta")]
    path = tmp_path / "lock.json"
    data = write_lock(path, file_server, built, MODEL)
    return path, data


def snapshot(root: Path, repo: str, revision: str) -> Path:
    return (root / "models" / ("models--" + repo.replace("/", "--"))
            / "snapshots" / revision)


def test_install_fetches_verifies_and_records(start_helper, lock, tmp_path,
                                              file_server):
    path, data = lock
    root = tmp_path / "voice"
    helper = start_helper("--lock", str(path), root=root)
    before = helper.request("status")
    total = sum(w["size"] for w in data["wheels"]) + sum(
        m["size"] for m in data["model"])
    assert before["installed"] is False
    assert before["downloadBytes"] == total
    assert before["lock"] == "test-1"

    reply = helper.request("install")
    assert reply["ok"] is True, reply

    assert (root / "lib" / "alpha" / "__init__.py").is_file()
    assert (root / "lib" / "beta" / "__init__.py").is_file()
    for (repo, file), content in MODEL.items():
        entry = next(m for m in data["model"]
                     if m["repo"] == repo and m["path"] == file)
        dest = snapshot(root, repo, entry["revision"]) / file
        assert dest.read_bytes() == content
        refs = dest.parent.parent.parent / "refs" / "main"
        assert refs.read_text() == entry["revision"]
    state = json.loads((root / "state.json").read_text())
    assert state["lock"] == "test-1"
    assert not (root / "downloads").exists()

    progress = [e for e in helper.events if e.get("event") == "progress"]
    assert {e["phase"] for e in progress} == {"packages", "model"}
    assert progress[-1]["done"] == progress[-1]["total"] == total
    assert all(e["total"] == total for e in progress)
    assert [e["done"] for e in progress] == sorted(e["done"]
                                                    for e in progress)

    after = helper.request("status")
    assert after["installed"] is True
    assert after["installedBytes"] >= sum(m["size"] for m in data["model"])


def test_rerun_is_a_no_op(start_helper, lock, file_server):
    path, _ = lock
    helper = start_helper("--lock", str(path))
    assert helper.request("install")["ok"] is True
    fetched = len(file_server.requests)
    again = helper.request("install")
    assert again["ok"] is True
    assert again["alreadyInstalled"] is True
    assert len(file_server.requests) == fetched


def test_hash_mismatch_fails_with_a_clear_code(start_helper, lock,
                                               file_server, tmp_path):
    path, data = lock
    bad = data["model"][0]
    url = f"/hf/{bad['repo']}/resolve/{bad['revision']}/{bad['path']}"
    file_server.files[url] = os.urandom(bad["size"])
    root = tmp_path / "voice"
    helper = start_helper("--lock", str(path), root=root)
    reply = helper.request("install")
    assert reply["ok"] is False
    assert reply["code"] == "hash-mismatch"
    assert bad["path"] in reply["error"]
    assert not (root / "state.json").exists()
    assert helper.request("status")["installed"] is False
    leftovers = list((root / "models").rglob("*.partial"))
    assert leftovers == []


def test_wheel_hash_mismatch(start_helper, lock, file_server, tmp_path):
    path, data = lock
    wheel = data["wheels"][0]
    file_server.files[wheel["url"].removeprefix(file_server.base)] = b"x" * (
        wheel["size"])
    reply = start_helper("--lock", str(path)).request("install")
    assert reply["ok"] is False
    assert reply["code"] == "hash-mismatch"


def test_interrupted_download_resumes_with_range(start_helper, lock,
                                                 file_server, tmp_path):
    path, data = lock
    big = data["model"][0]
    url = f"/hf/{big['repo']}/resolve/{big['revision']}/{big['path']}"
    file_server.cut_after[url] = 100_000
    root = tmp_path / "voice"
    helper = start_helper("--lock", str(path), root=root)
    first = helper.request("install")
    assert first["ok"] is False
    assert first["code"] == "download-failed"
    partial = list((root / "models").rglob("*.partial"))
    assert len(partial) == 1
    assert partial[0].stat().st_size == 100_000

    file_server.requests.clear()
    second = helper.request("install")
    assert second["ok"] is True, second
    assert (url, "bytes=100000-") in file_server.requests
    fetched = [p for p, _ in file_server.requests]
    assert not any(p.startswith("/wheels/") for p in fetched)
    dest = snapshot(root, big["repo"], big["revision"]) / big["path"]
    assert dest.read_bytes() == MODEL[(big["repo"], big["path"])]


def test_server_ignoring_range_restarts_the_file(start_helper, lock,
                                                 file_server, tmp_path):
    path, data = lock
    big = data["model"][0]
    url = f"/hf/{big['repo']}/resolve/{big['revision']}/{big['path']}"
    file_server.ignore_range.add(url)
    root = tmp_path / "voice"
    dest = snapshot(root, big["repo"], big["revision"])
    dest.mkdir(parents=True)
    (dest / (big["path"] + ".partial")).write_bytes(b"\0" * 1000)
    reply = start_helper("--lock", str(path), root=root).request("install")
    assert reply["ok"] is True, reply
    assert (url, "bytes=1000-") in file_server.requests
    assert (dest / big["path"]).read_bytes() == MODEL[(big["repo"],
                                                       big["path"])]


def test_cancel_mid_install_keeps_partial_files(start_helper, lock,
                                                file_server, tmp_path):
    path, data = lock
    big = data["model"][0]
    url = f"/hf/{big['repo']}/resolve/{big['revision']}/{big['path']}"
    file_server.slow.add(url)
    root = tmp_path / "voice"
    helper = start_helper("--lock", str(path), root=root)
    install = helper.send("install")
    helper.wait_event(lambda e: e.get("event") == "progress"
                      and e.get("file") == big["path"]
                      and e["done"] > sum(w["size"] for w in data["wheels"]))
    cancel = helper.request("cancel", target=install)
    assert cancel["ok"] is True
    assert cancel["cancelled"] is True
    reply = helper.wait(install)
    assert reply["ok"] is False
    assert reply["code"] == "cancelled"
    partial = list((root / "models").rglob("*.partial"))
    assert len(partial) == 1
    assert 0 < partial[0].stat().st_size < big["size"]
    assert not (root / "state.json").exists()

    file_server.slow.clear()
    again = helper.request("install")
    assert again["ok"] is True
    assert any(r is not None and r.startswith("bytes=")
               for p, r in file_server.requests if p == url)


def test_second_install_while_one_runs_is_busy(start_helper, lock,
                                               file_server):
    path, data = lock
    big = data["model"][0]
    file_server.slow.add(
        f"/hf/{big['repo']}/resolve/{big['revision']}/{big['path']}")
    helper = start_helper("--lock", str(path))
    first = helper.send("install")
    second = helper.request("install")
    assert second["ok"] is False
    assert second["code"] == "busy"
    helper.request("cancel", target=first)
    helper.wait(first)


def test_remove_deletes_what_the_helper_installed(start_helper, lock,
                                                  tmp_path):
    path, _ = lock
    root = tmp_path / "voice"
    (root / "python" / "bin").mkdir(parents=True)
    (root / "python" / "bin" / "python3").write_text("app-owned")
    (root / "helper").mkdir()
    (root / "helper" / "marker").write_text("app-owned")
    helper = start_helper("--lock", str(path), root=root)
    assert helper.request("install")["ok"] is True
    from conftest import b64, make_wav
    vid = helper.request("voice", voice=b64(make_wav()),
                         format="wav")["voiceId"]
    helper.request("speak", voiceId=vid, text="Cached before remove.")
    reply = helper.request("remove")
    assert reply["ok"] is True
    assert sorted(p.name for p in root.iterdir()) == ["helper", "python"]
    status = helper.request("status")
    assert status["installed"] is False
    assert status["installedBytes"] == 0


def test_a_new_lock_id_needs_a_new_install(start_helper, lock, tmp_path,
                                           file_server):
    path, data = lock
    root = tmp_path / "voice"
    helper = start_helper("--lock", str(path), root=root)
    assert helper.request("install")["ok"] is True
    helper.request("quit")
    helper.proc.wait(timeout=10)
    data["id"] = "test-2"
    path.write_text(json.dumps(data))
    status = start_helper("--lock", str(path), root=root).request("status")
    assert status["installed"] is False
    assert status["lock"] == "test-2"
