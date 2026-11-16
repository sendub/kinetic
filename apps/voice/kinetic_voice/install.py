"""Installing a lock's packages and model files into the voice folder.

Wheels download into ``downloads/``, are checked against the lock's
sha256 and installed by pip from those local files only. Model files
download straight into ``models/``, laid out as a Hugging Face hub cache
(``models--<org>--<name>/snapshots/<revision>/<path>`` and
``refs/main``), so the engine can load them with the hub offline. A
download in progress is ``<file>.partial``: a later run continues it
with an HTTP Range request, and a finished file is never fetched again.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import platform
import re
import shutil
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from pathlib import Path

CHUNK = 1 << 20
Hash = type(hashlib.sha256())
HF_BASE = "https://huggingface.co"
#: What ``remove`` deletes; ``python/`` and ``helper/`` belong to the app.
OWNED = ("lib", "lib.partial", "models", "downloads", "cache", "state.json")
#: Names the apps use for the private Python they unpack.
PYTHON_DIR = "python"
PYTHON_MARKER = ".kinetic-python"


class InstallError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def platform_key() -> str:
    system = {"Darwin": "macos", "Windows": "windows"}.get(
        platform.system(), platform.system().lower())
    machine = {"x86_64": "x64", "AMD64": "x64", "aarch64": "arm64"}.get(
        platform.machine(), platform.machine().lower())
    return f"{system}-{machine}"


def default_lock_path() -> Path:
    """``lock-<platform>.json`` beside the package: ``apps/voice/`` in the
    repo, ``helper/`` in the voice folder."""
    return Path(__file__).resolve().parent.parent / (
        f"lock-{platform_key()}.json")


def python_executable(root: Path) -> Path:
    """The private Python's program in the voice folder ``root``."""
    base = root / PYTHON_DIR
    return base / "python.exe" if os.name == "nt" else base / "bin" / "python3"


def _version(text: str) -> tuple[int, ...]:
    return tuple(int(p) for p in text.split(".") if p.isdigit())


#: Where Windows keeps nvidia-smi when its folder is not on the PATH.
NVIDIA_SMI_WINDOWS = r"C:\Windows\System32\nvidia-smi.exe"


def nvidia_driver() -> str | None:
    """The NVIDIA driver's version when a GPU is usable, else ``None``.

    ``nvidia-smi`` on the PATH or at its place in the Windows system
    folder must run and exit 0. The answer is ``""`` when it ran but its
    output is not a version number (a GPU all the same).
    """
    exe = shutil.which("nvidia-smi")
    if exe is None and os.path.isfile(NVIDIA_SMI_WINDOWS):
        exe = NVIDIA_SMI_WINDOWS
    if exe is None:
        return None
    try:
        result = subprocess.run(
            [exe, "--query-gpu=driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15, check=False,
            stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    first = (result.stdout or "").strip().splitlines()
    version = first[0].strip() if first else ""
    return version if re.fullmatch(r"\d+(\.\d+)*", version) else ""


class Lock:
    """A lock file: pinned wheels, model files and engine settings."""

    def __init__(self, data: dict) -> None:
        self.data = data
        self.id: str = data["id"]
        self.model: list[dict] = data["model"]
        self.engine: dict = data["engine"]
        self.model_base: str = data.get("modelBaseUrl", HF_BASE)

    @classmethod
    def read(cls, path: Path) -> Lock:
        return cls(json.loads(path.read_text()))

    def variant(self) -> str | None:
        """``"cuda"`` or ``"cpu"`` when the lock has wheels per variant
        (PyTorch's CUDA and CPU builds), else ``None``. CUDA only on a
        machine with a usable NVIDIA GPU whose driver is at least the
        lock's ``cudaMinDriver``; ``KINETIC_VOICE_VARIANT`` forces one."""
        if not any("variant" in w for w in self.data["wheels"]):
            return None
        forced = os.environ.get("KINETIC_VOICE_VARIANT", "").lower()
        if forced in ("cuda", "cpu"):
            return forced
        driver = nvidia_driver()
        if driver is None:
            return "cpu"
        need = self.data.get("cudaMinDriver")
        if need and driver and _version(driver) < _version(need):
            return "cpu"
        return "cuda"

    def wheels(self, macos: str | None = None,
               variant: str | None = None) -> list[dict]:
        """One wheel per package: an entry without ``minMacos``, or the
        newest build whose ``minMacos`` this system meets; of the entries
        with a ``variant``, those of this machine's (see ``variant``)."""
        mac = _version(macos if macos is not None
                       else platform.mac_ver()[0] or "0")
        variant = variant or self.variant()
        chosen: dict[str, dict] = {}
        for entry in self.data["wheels"]:
            if entry.get("variant") not in (None, variant):
                continue
            need = entry.get("minMacos")
            if need is not None and _version(need) > mac:
                continue
            best = chosen.get(entry["name"])
            if best is None or _version(need or "0") > _version(
                    best.get("minMacos") or "0"):
                chosen[entry["name"]] = entry
        missing = {e["name"] for e in self.data["wheels"]} - set(chosen)
        if missing:
            oldest = [e["minMacos"] for e in self.data["wheels"]
                      if e["name"] in missing and "minMacos" in e]
            if not oldest:
                raise ValueError("no build of " + ", ".join(sorted(missing))
                                 + f" for the {variant} variant")
            raise ValueError(
                f"needs macOS {min(oldest, key=_version)} or later")
        return list(chosen.values())

    def model_url(self, entry: dict) -> str:
        path = urllib.parse.quote(entry["path"])
        return (f"{self.model_base}/{entry['repo']}/resolve/"
                f"{entry['revision']}/{path}")


def wheel_filename(entry: dict) -> str:
    return urllib.parse.unquote(entry["url"].rsplit("/", 1)[-1])


def model_dir(root: Path, repo: str) -> Path:
    return root / "models" / ("models--" + repo.replace("/", "--"))


def model_path(root: Path, entry: dict) -> Path:
    return (model_dir(root, entry["repo"]) / "snapshots" / entry["revision"]
            / entry["path"])


def ssl_context() -> ssl.SSLContext:
    """OpenSSL's default certificates (python-build-standalone's look in
    /etc/ssl on a Mac, and Windows's store on Windows), with the Mac's
    system bundle as a fallback when none load."""
    ctx = ssl.create_default_context()
    if not ctx.get_ca_certs() and Path("/etc/ssl/cert.pem").exists():
        ctx.load_verify_locations("/etc/ssl/cert.pem")
    return ctx


def folder_bytes(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for dirpath, _, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(dirpath, name)).st_size
            except OSError:
                pass
    return total


def run_pip(requirements: Path, target: Path, cancel: threading.Event,
            tmp: Path) -> None:
    """pip from this Python, offline, hash-checked, into ``target``, with
    its temporary files in ``tmp``."""
    cmd = [sys.executable, "-m", "pip", "install", "--target", str(target),
           "--no-deps", "--require-hashes", "--only-binary", ":all:",
           "--no-index", "--no-cache-dir", "--disable-pip-version-check",
           "--no-input", "-r", str(requirements)]
    tmp.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "PIP_CONFIG_FILE": os.devnull,
           "PYTHONNOUSERSITE": "1", "TMPDIR": str(tmp)}
    # stdin is the null device: the helper's own stdin is the app's pipe,
    # and a child that inherits it deadlocks at startup on Windows.
    proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, env=env)
    while True:
        try:
            out, _ = proc.communicate(timeout=0.2)
            break
        except subprocess.TimeoutExpired:
            if cancel.is_set():
                proc.kill()
                proc.wait()
                raise InstallError("cancelled", "install cancelled") from None
    sys.stderr.write(out.decode(errors="replace"))
    if proc.returncode != 0:
        tail = out.decode(errors="replace").strip().splitlines()[-3:]
        raise InstallError("pip-failed", "pip failed: " + " ".join(tail))


class Installer:
    """Install, check and remove one lock's files under ``root``."""

    def __init__(self, root: Path, lock: Lock,
                 emit: Callable[[dict], None],
                 pip: Callable[..., None] = run_pip) -> None:
        self.root = root
        self.lock = lock
        self.emit = emit
        self.pip = pip
        self._ctx: ssl.SSLContext | None = None
        self._variant: str | None = None

    # What is there

    def _choose_variant(self) -> None:
        """Look at the machine once per call into the installer (the GPU
        check runs a program), not once per wheel list."""
        self._variant = self.lock.variant()

    def selected_wheels(self) -> list[dict]:
        return self.lock.wheels(variant=self._variant)

    def total_bytes(self) -> int:
        return (sum(w["size"] for w in self.selected_wheels())
                + sum(m["size"] for m in self.lock.model))

    def _marker(self) -> Path:
        return self.root / "lib" / ".kinetic-packages.json"

    def packages_ready(self) -> bool:
        try:
            marker = json.loads(self._marker().read_text())
        except (OSError, ValueError):
            return False
        return marker == sorted(wheel_filename(w)
                                for w in self.selected_wheels())

    def model_ready(self, entry: dict) -> bool:
        path = model_path(self.root, entry)
        return path.is_file() and path.stat().st_size == entry["size"]

    def installed(self) -> bool:
        self._choose_variant()
        return self._installed()

    def _installed(self) -> bool:
        try:
            state = json.loads((self.root / "state.json").read_text())
        except (OSError, ValueError):
            return False
        return (state.get("lock") == self.lock.id and self.packages_ready()
                and all(self.model_ready(m) for m in self.lock.model))

    def _have_bytes(self) -> int:
        """Bytes of this lock's downloads already on disk."""
        have = 0
        if self.packages_ready():
            have += sum(w["size"] for w in self.selected_wheels())
        else:
            for w in self.selected_wheels():
                have += self._partial_size(
                    self.root / "downloads" / wheel_filename(w), w["size"])
        for m in self.lock.model:
            have += self._partial_size(model_path(self.root, m), m["size"])
        return have

    @staticmethod
    def _partial_size(path: Path, size: int) -> int:
        for candidate in (path, path.with_name(path.name + ".partial")):
            if candidate.is_file():
                return min(candidate.stat().st_size, size)
        return 0

    def status(self) -> dict:
        self._choose_variant()
        total = self.total_bytes()
        return {
            "installed": self._installed(),
            "lock": self.lock.id,
            "variant": self._variant,
            "downloadBytes": total,
            "remainingBytes": total - self._have_bytes(),
            "installedBytes": sum(folder_bytes(self.root / name)
                                  for name in OWNED
                                  if (self.root / name).exists()),
        }

    # The private Python (what the apps do before they can start the
    # helper; tools/record_lines.py does it the same way)

    def python_ready(self) -> bool:
        py = self.lock.data["python"]
        try:
            marker = (self.root / PYTHON_DIR / PYTHON_MARKER).read_text()
        except OSError:
            return False
        return marker == py["sha256"] and python_executable(
            self.root).is_file()

    def install_python(self, cancel: threading.Event) -> bool:
        """Download the lock's Python build (resumed, sha256-checked),
        unpack it with the system ``tar`` into ``python/`` and mark it.
        Progress events count the archive's bytes. False when the right
        build is already there."""
        if self.python_ready():
            return False
        py = self.lock.data["python"]
        self._total, self._done, self._last_emit = py["size"], 0, 0.0
        archive = (self.root / "downloads"
                   / f"python-{py['sha256'][:12]}.tar.gz")
        self._fetch(py["url"], archive, py["size"], py["sha256"], "python",
                    archive.name, cancel)
        staging = self.root / (PYTHON_DIR + ".partial")
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        self.emit({"event": "log", "message": "unpacking python"})
        result = subprocess.run(
            ["tar", "-xzf", str(archive), "-C", str(staging)],
            capture_output=True, text=True, check=False,
            stdin=subprocess.DEVNULL)
        unpacked = staging / PYTHON_DIR
        if result.returncode != 0 or not python_executable(staging).is_file():
            shutil.rmtree(staging, ignore_errors=True)
            raise InstallError(
                "unpack-failed", "the Python download could not be "
                + "unpacked: " + (result.stderr.strip() or "no python/"))
        (unpacked / PYTHON_MARKER).write_text(py["sha256"])
        shutil.rmtree(self.root / PYTHON_DIR, ignore_errors=True)
        os.replace(unpacked, self.root / PYTHON_DIR)
        shutil.rmtree(staging, ignore_errors=True)
        archive.unlink(missing_ok=True)
        try:
            archive.parent.rmdir()  # downloads/ only if nothing else is in it
        except OSError:
            pass
        return True

    # Installing

    def run(self, cancel: threading.Event) -> dict:
        self._choose_variant()
        if self._installed():
            return {"alreadyInstalled": True}
        started = time.time()
        self._total = self.total_bytes()
        self._done = 0
        self._last_emit = 0.0
        self._packages(cancel)
        self._model(cancel)
        self._write_state()
        return {"alreadyInstalled": False,
                "seconds": round(time.time() - started, 1)}

    def _progress(self, phase: str, file: str, force: bool = False) -> None:
        now = time.monotonic()
        if force or now - self._last_emit >= 0.25:
            self._last_emit = now
            self.emit({"event": "progress", "phase": phase,
                       "done": self._done, "total": self._total,
                       "file": file})

    def _packages(self, cancel: threading.Event) -> None:
        wheels = self.selected_wheels()
        if self.packages_ready():
            self._done += sum(w["size"] for w in wheels)
            self._progress("packages", "", force=True)
            return
        downloads = self.root / "downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        lines = []
        for w in wheels:
            name = wheel_filename(w)
            dest = downloads / name
            self._fetch(w["url"], dest, w["size"], w["sha256"], "packages",
                        name, cancel)
            lines.append(f"{dest} --hash=sha256:{w['sha256']}\n")
        requirements = downloads / "requirements.txt"
        requirements.write_text("".join(lines))
        staging = self.root / "lib.partial"
        shutil.rmtree(staging, ignore_errors=True)
        self.emit({"event": "log", "message": "installing packages"})
        self.pip(requirements, staging, cancel, downloads / "tmp")
        (staging / ".kinetic-packages.json").write_text(
            json.dumps(sorted(wheel_filename(w) for w in wheels)))
        shutil.rmtree(self.root / "lib", ignore_errors=True)
        os.replace(staging, self.root / "lib")
        shutil.rmtree(downloads, ignore_errors=True)

    def _model(self, cancel: threading.Event) -> None:
        for m in self.lock.model:
            dest = model_path(self.root, m)
            if self.model_ready(m):
                # On disk from an earlier install: it counts as done.
                self._done += m["size"]
                self._progress("model", m["path"], force=True)
            else:
                self._fetch(self.lock.model_url(m), dest, m["size"],
                            m["sha256"], "model", m["path"], cancel)
            refs = model_dir(self.root, m["repo"]) / "refs" / "main"
            refs.parent.mkdir(parents=True, exist_ok=True)
            refs.write_text(m["revision"])

    def _write_state(self) -> None:
        state = {
            "lock": self.lock.id,
            "engine": self.lock.engine.get("id"),
            "python": self.lock.data.get("python", {}).get("version"),
            "variant": self._variant,
            "wheels": sorted(wheel_filename(w)
                             for w in self.selected_wheels()),
            "model": [{k: m[k] for k in ("repo", "revision", "path")}
                      for m in self.lock.model],
            "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ",
                                         time.gmtime()),
        }
        tmp = self.root / "state.json.tmp"
        tmp.write_text(json.dumps(state, indent=1))
        os.replace(tmp, self.root / "state.json")

    def _fetch(self, url: str, dest: Path, size: int, sha256: str,
               phase: str, label: str, cancel: threading.Event) -> None:
        """Download ``url`` to ``dest`` via ``dest.partial``, resuming a
        partial file and checking size and sha256 before the rename."""
        if dest.is_file() and dest.stat().st_size == size:
            self._done += size
            self._progress(phase, label, force=True)
            return
        dest.parent.mkdir(parents=True, exist_ok=True)
        partial = dest.with_name(dest.name + ".partial")
        digest = hashlib.sha256()
        have = partial.stat().st_size if partial.is_file() else 0
        if have > size:
            partial.unlink()
            have = 0
        if have:
            with partial.open("rb") as f:
                while block := f.read(CHUNK):
                    digest.update(block)
        self._done += have
        if have < size:
            have, digest = self._stream(url, partial, have, digest, phase,
                                        label, cancel)
        if have != size:
            raise InstallError("download-failed",
                               f"{label}: got {have} of {size} bytes")
        if digest.hexdigest() != sha256:
            partial.unlink()
            self._done -= size
            raise InstallError("hash-mismatch",
                               f"{label}: sha256 does not match the lock")
        os.replace(partial, dest)
        self._progress(phase, label, force=True)

    def _stream(self, url: str, partial: Path, have: int, digest: Hash,
                phase: str, label: str, cancel: threading.Event,
                ) -> tuple[int, Hash]:
        """Append the rest of ``url`` to ``partial``: (bytes, digest)."""
        request = urllib.request.Request(
            url, headers={"User-Agent": "kinetic-voice"})
        if have:
            request.add_header("Range", f"bytes={have}-")
        if self._ctx is None and url.startswith("https:"):
            self._ctx = ssl_context()
        try:
            with urllib.request.urlopen(request, timeout=60,
                                        context=self._ctx) as response:
                if have and response.status != 206:
                    # The server sent the whole file: start again.
                    self._done -= have
                    have = 0
                    digest = hashlib.sha256()
                with partial.open("ab" if have else "wb") as out:
                    while block := response.read1(CHUNK):
                        if cancel.is_set():
                            raise InstallError("cancelled",
                                               "install cancelled")
                        out.write(block)
                        digest.update(block)
                        have += len(block)
                        self._done += len(block)
                        self._progress(phase, label)
        except urllib.error.HTTPError as err:
            raise InstallError("download-failed",
                               f"{label}: HTTP {err.code}") from None
        except (OSError, http.client.HTTPException) as err:
            # Includes a dropped connection: the partial file is kept.
            raise InstallError("download-failed", f"{label}: {err}") from None
        return have, digest

    # Removing

    def remove(self) -> None:
        for name in OWNED:
            path = self.root / name
            if path.is_dir():
                shutil.rmtree(path)
            elif path.exists():
                path.unlink()
