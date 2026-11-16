"""The Windows backend's platform-neutral parts: one CUDA build of PyTorch
(a PC with no NVIDIA card is refused by the exe, never the helper), the
installer's byte totals, engine selection, the PyTorch engine with PyTorch
absent, and the Windows lock's shape. The engine itself runs only where
the install put PyTorch; the real run is in the README's measurements."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import threading

import pytest
from conftest import VOICE_DIR, sha
from kinetic_voice import install
from kinetic_voice.engine import create_engine
from kinetic_voice.install import Installer, InstallError, Lock


def fake_pip(requirements, target, cancel, tmp):
    target.mkdir(parents=True)


@pytest.fixture
def small_lock(tmp_path, file_server):
    """A lock with a 'torch' and a 'tiny' wheel, served locally; the files
    are not real wheels, so tests use a fake pip."""
    wheels = []
    for name, size in [("torch", 3000), ("tiny", 100)]:
        data = bytes([len(name)]) * size
        file = f"{name}.whl"
        file_server.files["/wheels/" + file] = data
        wheels.append({"name": name,
                       "url": file_server.base + "/wheels/" + file,
                       "sha256": sha(data), "size": size})
    model = b"m" * 500
    file_server.files["/hf/org/m/resolve/rev1/f.bin"] = model
    return Lock({"id": "w-1", "wheels": wheels,
                 "modelBaseUrl": file_server.base + "/hf",
                 "model": [{"repo": "org/m", "revision": "rev1",
                            "path": "f.bin", "sha256": sha(model),
                            "size": 500}],
                 "engine": {"id": "fake"}})


def test_there_is_no_gpu_check_or_variant_in_the_helper():
    # The exe looks for the NVIDIA card (apps/windows); the helper only
    # installs what the lock lists.
    assert not hasattr(install, "nvidia_driver")
    assert not hasattr(Lock, "variant")


def test_download_bytes_are_every_wheel_and_model_file(tmp_path, small_lock):
    status = Installer(tmp_path, small_lock, lambda e: None,
                       fake_pip).status()
    assert status["downloadBytes"] == status["remainingBytes"] == 3600
    assert "variant" not in status


def test_install_fetches_every_wheel(tmp_path, small_lock, file_server):
    events = []
    installer = Installer(tmp_path, small_lock, events.append, fake_pip)
    installer.run(threading.Event())
    fetched = {p for p, _ in file_server.requests}
    assert {"/wheels/torch.whl", "/wheels/tiny.whl"} <= fetched
    last = [e for e in events if e.get("event") == "progress"][-1]
    assert last["done"] == last["total"] == 3600
    state = json.loads((tmp_path / "state.json").read_text())
    assert "torch.whl" in state["wheels"]
    assert "variant" not in state


def test_install_error_type_is_still_exported():
    assert InstallError("x", "y").code == "x"


# Engine selection

def test_the_torch_engine_is_chosen_by_name_without_importing_torch(
        tmp_path):
    assert "torch" not in sys.modules
    engine = create_engine("chatterbox-torch", tmp_path, {"engine": {},
                                                          "model": []})
    assert engine.name == "chatterbox-torch"
    assert engine.requires_install
    assert "torch" not in sys.modules


def test_an_unknown_engine_is_refused(tmp_path):
    with pytest.raises(ValueError, match="nope"):
        create_engine("nope", tmp_path, {})


def windows_lock():
    return json.loads((VOICE_DIR / "lock-windows-x64.json").read_text())


def test_the_windows_lock_names_the_torch_engine():
    assert windows_lock()["engine"]["id"] == "chatterbox-torch"


def torch_engine(tmp_path, **settings):
    data = windows_lock()
    data["engine"].update(settings)
    return create_engine("chatterbox-torch", tmp_path, data)


def test_the_line_cache_key_follows_the_settings(tmp_path):
    base = torch_engine(tmp_path).identity()
    assert base["engine"] == "chatterbox-torch"
    assert torch_engine(tmp_path, flowSteps=9).identity() != base
    assert "device" not in base


def test_loading_without_pytorch_is_a_clear_error(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "torch", None)  # import fails
    engine = torch_engine(tmp_path)
    with pytest.raises(RuntimeError, match="PyTorch is not installed"):
        engine.load()
    assert not engine.loaded


def test_the_helper_runs_with_the_torch_engine_but_nothing_installed(
        start_helper):
    helper = start_helper(
        "--lock", str(VOICE_DIR / "lock-windows-x64.json"),
        engine="chatterbox-torch")
    status = helper.request("status")
    assert status["ok"] and status["engine"] == "chatterbox-torch"
    assert status["installed"] is False
    assert helper.request("warm")["code"] == "not-installed"


def test_the_helper_takes_the_engine_from_the_lock(start_helper, tmp_path):
    data = windows_lock()
    data["engine"]["id"] = "fake"
    path = tmp_path / "lock.json"
    path.write_text(json.dumps(data))
    helper = start_helper("--lock", str(path), engine="")
    assert helper.request("status")["engine"] == "fake"


# The device

def test_the_device_is_cuda():
    from kinetic_voice.engine_torch import resolve_device
    assert resolve_device(True) == "cuda"


def test_without_cuda_the_engine_refuses_to_run():
    from kinetic_voice.engine_torch import resolve_device
    with pytest.raises(RuntimeError, match="NVIDIA"):
        resolve_device(False)


def test_punctuation_is_normalised_as_chatterbox_does():
    from kinetic_voice.engine_torch import punc_norm
    assert punc_norm("hello  there") == "Hello there."
    # (the package's replacements leave a double space after "...", ";")
    assert punc_norm("Wait... what; no: yes") == "Wait,  what,  no, yes."
    assert punc_norm("“Quoted” — fine") == "\"Quoted\" - fine."
    assert punc_norm("Done!") == "Done!"
    assert punc_norm("") == "You need to add some text for me to talk."


# The Windows lock

def test_windows_lock_is_complete():
    data = windows_lock()
    assert re.fullmatch(r"windows-x64-\d+", data["id"])
    py = data["python"]
    assert py["version"] == "3.12.16" and py["release"] == "20261110"
    assert py["url"] == (
        "https://github.com/astral-sh/python-build-standalone/releases/"
        "download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-"
        "msvc-install_only.tar.gz")
    assert py["size"] == 47_438_699
    assert re.fullmatch(r"[0-9a-f]{64}", py["sha256"])
    for w in data["wheels"]:
        assert w["url"].startswith(("https://files.pythonhosted.org/",
                                    "https://download.pytorch.org/"))
        name = w["url"].rsplit("/", 1)[-1]
        assert re.search(r"-(cp312-\w+-win_amd64|py3-none-any|"
                         r"cp3\d+-abi3-win_amd64|py2\.py3-none-any|"
                         r"py2\.py3-none-win_amd64)\.whl$", name), name
        assert re.fullmatch(r"[0-9a-f]{64}", w["sha256"])
        assert w["size"] > 0
        assert "variant" not in w
    repos = {m["repo"] for m in data["model"]}
    assert repos == {"ResembleAI/chatterbox"}
    for m in data["model"]:
        assert re.fullmatch(r"[0-9a-f]{40}", m["revision"])
        assert re.fullmatch(r"[0-9a-f]{64}", m["sha256"])
    assert data["engine"]["id"] == "chatterbox-torch"


def test_windows_lock_has_one_wheel_per_package_and_torch_is_cuda():
    lock = Lock(windows_lock())
    names = [w["name"] for w in lock.data["wheels"]]
    assert len(set(names)) == len(names)
    chosen = {w["name"]: w for w in lock.wheels()}
    assert len(chosen) == len(names)
    assert "%2Bcu128" in chosen["torch"]["url"]
    assert "%2Bcu128" in chosen["torchaudio"]["url"]
    assert "cpu" not in json.dumps(lock.data).lower().replace(
        "cpython", "")


def test_windows_lock_names_the_minimum_driver_the_exe_checks():
    assert re.fullmatch(r"\d+\.\d+", windows_lock()["cudaMinDriver"])


def test_windows_lock_download_sizes():
    lock = Lock(windows_lock())
    total = (sum(w["size"] for w in lock.wheels())
             + sum(m["size"] for m in lock.model))
    assert 6.5e9 < total < 7.2e9  # CUDA PyTorch, the rest, the model files


def test_windows_lock_engine_settings_match_the_mac_engines():
    win = windows_lock()["engine"]
    mac = json.loads((VOICE_DIR / "lock-macos-arm64.json").read_text())[
        "engine"]
    for key in ("cfgWeight", "exaggeration", "temperature", "minP",
                "repetitionPenalty", "maxTokens", "flowSteps",
                "promptSeconds", "stream"):
        assert win[key] == mac[key], key
    assert win["repo"] == "ResembleAI/chatterbox"
    assert {"t3", "s3gen", "ve", "tokenizer"} <= set(win["files"])
    repo_files = {m["path"] for m in windows_lock()["model"]}
    assert set(win["files"].values()) <= repo_files


# pip must not share the helper's stdin

def test_pip_does_not_inherit_the_helpers_stdin(tmp_path, monkeypatch):
    """On Windows a child that inherits the pipe the helper is reading
    deadlocks at startup. The stand-in child reads its stdin to the end:
    it finishes only if that is not the open pipe the parent never
    writes to."""
    import os
    real = subprocess.Popen
    child = [sys.executable, "-c",
             "import sys; sys.exit(0 if sys.stdin.read() == '' else 3)"]
    monkeypatch.setattr(install.subprocess, "Popen",
                        lambda cmd, **kw: real(child, **kw))
    read_end, write_end = os.pipe()
    saved = os.dup(0)
    os.dup2(read_end, 0)
    outcome: list[object] = []

    def call():
        try:
            install.run_pip(tmp_path / "r.txt", tmp_path / "t",
                            threading.Event(), tmp_path / "tmp")
            outcome.append("done")
        except Exception as err:  # noqa: BLE001
            outcome.append(err)
    worker = threading.Thread(target=call, daemon=True)
    try:
        worker.start()
        worker.join(15)
        hung = worker.is_alive()
    finally:
        os.dup2(saved, 0)
        os.close(saved)
        os.close(write_end)  # lets a hung child finish
        os.close(read_end)
        worker.join(5)
    assert not hung, "pip's stdin is the helper's open pipe"
    assert outcome == ["done"]


# Reading the app's pipe without a pending read (Windows)

def test_input_lines_pass_a_stream_through_off_windows():
    import io

    from kinetic_voice.pipe import input_lines
    assert list(input_lines(io.BytesIO(b'{"a":1}\n\n{"b":2}\nlast'))) == [
        b'{"a":1}\n', b"\n", b'{"b":2}\n', b"last"]


def test_polled_chunks_become_lines_whatever_their_boundaries():
    from kinetic_voice.pipe import lines_from_chunks
    chunks = iter([b'{"a"', b':1}\n{"b":2}', b"\n", b"", b"tail"])
    assert list(lines_from_chunks(chunks)) == [
        b'{"a":1}\n', b'{"b":2}\n', b"tail"]
