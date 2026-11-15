"""The Windows backend's platform-neutral parts: wheel variants (CPU and
CUDA PyTorch), NVIDIA detection, byte totals per variant, engine
selection, the PyTorch engine with PyTorch absent, and the Windows lock's
shape. The engine itself runs only where the install put PyTorch; the
real run is in the README's measurements."""

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

# The variants

def wheel(name, variant=None, size=1, tag="x"):
    entry = {"name": name, "url": f"https://x/{name}-{variant}-{tag}.whl",
             "sha256": "0" * 64, "size": size}
    if variant:
        entry["variant"] = variant
    return entry


TORCH = [wheel("torch", "cuda", 2_500), wheel("torch", "cpu", 200),
         wheel("torchaudio", "cuda", 10), wheel("torchaudio", "cpu", 5),
         wheel("numpy", None, 7)]


def lock_of(wheels, **extra):
    return Lock({"id": "t", "wheels": wheels, "model": [],
                 "engine": {}, **extra})


def urls(wheels):
    return sorted(w["url"].rsplit("/", 1)[-1] for w in wheels)


def test_cuda_variant_takes_the_cuda_builds_and_the_shared_wheels():
    chosen = lock_of(TORCH).wheels(variant="cuda")
    assert urls(chosen) == ["numpy-None-x.whl", "torch-cuda-x.whl",
                            "torchaudio-cuda-x.whl"]


def test_cpu_variant_takes_the_cpu_builds_and_the_shared_wheels():
    chosen = lock_of(TORCH).wheels(variant="cpu")
    assert urls(chosen) == ["numpy-None-x.whl", "torch-cpu-x.whl",
                            "torchaudio-cpu-x.whl"]


def test_a_lock_without_variants_never_looks_for_a_gpu(monkeypatch):
    def boom(*_):
        raise AssertionError("looked for a GPU")
    monkeypatch.setattr(install, "nvidia_driver", boom)
    assert len(lock_of([wheel("numpy")]).wheels("15.0")) == 1


def test_the_variant_defaults_to_what_the_machine_has(monkeypatch):
    monkeypatch.delenv("KINETIC_VOICE_VARIANT", raising=False)
    monkeypatch.setattr(install, "nvidia_driver", lambda: "572.83")
    assert "torch-cuda-x.whl" in urls(lock_of(TORCH).wheels())
    monkeypatch.setattr(install, "nvidia_driver", lambda: None)
    assert "torch-cpu-x.whl" in urls(lock_of(TORCH).wheels())


def test_a_driver_older_than_the_locks_minimum_gets_the_cpu_build(
        monkeypatch):
    monkeypatch.delenv("KINETIC_VOICE_VARIANT", raising=False)
    lock = lock_of(TORCH, cudaMinDriver="570.65")
    monkeypatch.setattr(install, "nvidia_driver", lambda: "566.36")
    assert lock.variant() == "cpu"
    monkeypatch.setattr(install, "nvidia_driver", lambda: "570.65")
    assert lock.variant() == "cuda"
    monkeypatch.setattr(install, "nvidia_driver", lambda: "572.83")
    assert lock.variant() == "cuda"
    monkeypatch.setattr(install, "nvidia_driver", lambda: "1000.1")
    assert lock.variant() == "cuda"  # compared by number, not text


def test_an_unreadable_driver_version_still_counts_as_a_gpu(monkeypatch):
    monkeypatch.delenv("KINETIC_VOICE_VARIANT", raising=False)
    monkeypatch.setattr(install, "nvidia_driver", lambda: "")
    assert lock_of(TORCH, cudaMinDriver="570.65").variant() == "cuda"


def test_the_environment_forces_a_variant(monkeypatch):
    monkeypatch.setattr(install, "nvidia_driver", lambda: "572.83")
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cpu")
    assert lock_of(TORCH).variant() == "cpu"
    monkeypatch.setattr(install, "nvidia_driver", lambda: None)
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cuda")
    assert lock_of(TORCH).variant() == "cuda"


def test_a_wheel_missing_for_the_variant_is_an_error():
    only_cuda = [w for w in TORCH if w.get("variant") != "cpu"
                 or w["name"] != "torch"]
    with pytest.raises(ValueError, match="torch"):
        lock_of(only_cuda).wheels(variant="cpu")


# NVIDIA detection

class Done:
    def __init__(self, code, out=""):
        self.returncode = code
        self.stdout = out


def fake_run(monkeypatch, found, result):
    """Pretend nvidia-smi is at ``found`` (a path or None) and ran as
    ``result`` (a Done, or an exception to raise)."""
    calls = []
    monkeypatch.setattr(install.shutil, "which",
                        lambda name: found if name == "nvidia-smi" else None)
    monkeypatch.setattr(install.os.path, "isfile", lambda p: False)

    def run(cmd, **kw):
        calls.append(cmd)
        if isinstance(result, Exception):
            raise result
        return result
    monkeypatch.setattr(install.subprocess, "run", run)
    return calls


def test_nvidia_driver_from_nvidia_smi_on_the_path(monkeypatch):
    calls = fake_run(monkeypatch, "/bin/nvidia-smi", Done(0, "572.83\n"))
    assert install.nvidia_driver() == "572.83"
    assert calls[0][0] == "/bin/nvidia-smi"


def test_nvidia_driver_from_the_system_folder_when_not_on_the_path(
        monkeypatch):
    calls = fake_run(monkeypatch, None, Done(0, "572.83\n"))
    system = r"C:\Windows\System32\nvidia-smi.exe"
    monkeypatch.setattr(install.os.path, "isfile", lambda p: p == system)
    assert install.nvidia_driver() == "572.83"
    assert calls[0][0] == system


def test_no_nvidia_smi_means_no_gpu(monkeypatch):
    fake_run(monkeypatch, None, Done(0, "572.83\n"))
    assert install.nvidia_driver() is None


def test_a_failing_nvidia_smi_means_no_gpu(monkeypatch):
    fake_run(monkeypatch, "/bin/nvidia-smi", Done(9, ""))
    assert install.nvidia_driver() is None


@pytest.mark.parametrize("error", [subprocess.TimeoutExpired("x", 1),
                                   OSError("not executable")])
def test_a_hung_or_broken_nvidia_smi_means_no_gpu(monkeypatch, error):
    fake_run(monkeypatch, "/bin/nvidia-smi", error)
    assert install.nvidia_driver() is None


def test_nvidia_smi_output_that_is_not_a_version_is_still_a_gpu(
        monkeypatch):
    fake_run(monkeypatch, "/bin/nvidia-smi", Done(0, "garbled\n"))
    assert install.nvidia_driver() == ""


# Byte totals and the install marker per variant

@pytest.fixture
def variant_lock(tmp_path, file_server):
    """A lock with CPU and CUDA 'torch' wheels of different sizes, served
    locally; the files are not real wheels, so tests use a fake pip."""
    wheels = []
    for name, variant, size in [("torch", "cuda", 3000),
                                ("torch", "cpu", 800),
                                ("tiny", None, 100)]:
        data = bytes([len(variant or "n")]) * size
        file = f"{name}-{variant}.whl"
        file_server.files["/wheels/" + file] = data
        entry = {"name": name, "url": file_server.base + "/wheels/" + file,
                 "sha256": sha(data), "size": size}
        if variant:
            entry["variant"] = variant
        wheels.append(entry)
    model = b"m" * 500
    file_server.files["/hf/org/m/resolve/rev1/f.bin"] = model
    return Lock({"id": "w-1", "wheels": wheels,
                 "modelBaseUrl": file_server.base + "/hf",
                 "model": [{"repo": "org/m", "revision": "rev1",
                            "path": "f.bin", "sha256": sha(model),
                            "size": 500}],
                 "engine": {"id": "fake"}})


def fake_pip(requirements, target, cancel, tmp):
    target.mkdir(parents=True)


@pytest.mark.parametrize("variant,total", [("cuda", 3600), ("cpu", 1400)])
def test_download_bytes_follow_the_variant(tmp_path, monkeypatch,
                                           variant_lock, variant, total):
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", variant)
    installer = Installer(tmp_path, variant_lock, lambda e: None, fake_pip)
    status = installer.status()
    assert status["downloadBytes"] == status["remainingBytes"] == total


def test_install_fetches_only_the_chosen_variant(tmp_path, monkeypatch,
                                                 variant_lock, file_server):
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cpu")
    events = []
    installer = Installer(tmp_path, variant_lock, events.append, fake_pip)
    installer.run(threading.Event())
    fetched = {p for p, _ in file_server.requests}
    assert "/wheels/torch-cpu.whl" in fetched
    assert "/wheels/torch-cuda.whl" not in fetched
    last = [e for e in events if e.get("event") == "progress"][-1]
    assert last["done"] == last["total"] == 1400
    state = json.loads((tmp_path / "state.json").read_text())
    assert "torch-cpu.whl" in state["wheels"]
    assert state["variant"] == "cpu"


def test_a_gpu_arriving_after_a_cpu_install_needs_the_cuda_build(
        tmp_path, monkeypatch, variant_lock):
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cpu")
    installer = Installer(tmp_path, variant_lock, lambda e: None, fake_pip)
    installer.run(threading.Event())
    assert installer.status()["installed"] is True
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cuda")
    status = installer.status()
    assert status["installed"] is False
    # The wheels go again (pip's input is deleted after an install); the
    # model files stay.
    assert status["remainingBytes"] == 3100


def test_status_reports_the_variant(tmp_path, monkeypatch, variant_lock):
    monkeypatch.setenv("KINETIC_VOICE_VARIANT", "cuda")
    assert Installer(tmp_path, variant_lock, lambda e: None,
                     fake_pip).status()["variant"] == "cuda"


def test_a_lock_without_variants_reports_none(tmp_path):
    lock = Lock({"id": "m", "wheels": [wheel("numpy")], "model": [],
                 "engine": {}})
    assert Installer(tmp_path, lock, lambda e: None,
                     fake_pip).status()["variant"] is None


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


def test_the_line_cache_key_follows_the_settings_and_the_device(
        tmp_path, monkeypatch):
    monkeypatch.delenv("KINETIC_VOICE_DEVICE", raising=False)
    base = torch_engine(tmp_path).identity()
    assert base["engine"] == "chatterbox-torch"
    assert torch_engine(tmp_path, flowSteps=9).identity() != base
    monkeypatch.setenv("KINETIC_VOICE_DEVICE", "cpu")
    assert torch_engine(tmp_path).identity() != base


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

@pytest.mark.parametrize("override,cuda,expect", [
    ("", True, "cuda"), ("", False, "cpu"), ("auto", True, "cuda"),
    ("cpu", True, "cpu"), ("CPU", False, "cpu"), ("cuda", True, "cuda"),
])
def test_device_choice(override, cuda, expect):
    from kinetic_voice.engine_torch import resolve_device
    assert resolve_device(override, cuda) == expect


def test_forcing_cuda_without_cuda_is_an_error():
    from kinetic_voice.engine_torch import resolve_device
    with pytest.raises(RuntimeError, match="CUDA"):
        resolve_device("cuda", False)
    with pytest.raises(ValueError, match="gpu"):
        resolve_device("gpu", True)


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
        assert w.get("variant") in (None, "cuda", "cpu")
    repos = {m["repo"] for m in data["model"]}
    assert repos == {"ResembleAI/chatterbox"}
    for m in data["model"]:
        assert re.fullmatch(r"[0-9a-f]{40}", m["revision"])
        assert re.fullmatch(r"[0-9a-f]{64}", m["sha256"])
    assert data["engine"]["id"] == "chatterbox-torch"


def test_windows_lock_has_one_wheel_per_package_in_each_variant():
    lock = Lock(windows_lock())
    names = {w["name"] for w in lock.data["wheels"]}
    for variant in ("cuda", "cpu"):
        chosen = lock.wheels(variant=variant)
        assert len({w["name"] for w in chosen}) == len(chosen) == len(names)
    cuda = {w["name"]: w for w in lock.wheels(variant="cuda")}
    cpu = {w["name"]: w for w in lock.wheels(variant="cpu")}
    assert {"torch", "torchaudio"} <= {
        n for n in names if cuda[n] != cpu[n]}
    assert "%2Bcu128" in cuda["torch"]["url"]
    assert "%2Bcpu" in cpu["torch"]["url"]


def test_windows_lock_download_sizes():
    lock = Lock(windows_lock())

    def total(variant):
        return (sum(w["size"] for w in lock.wheels(variant=variant))
                + sum(m["size"] for m in lock.model))
    assert total("cuda") - total("cpu") > 1.5e9  # the CUDA build is bigger
    assert total("cpu") > 3e9  # the model files


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
