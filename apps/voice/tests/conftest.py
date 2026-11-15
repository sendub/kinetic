"""Shared helpers for the voice helper's tests.

Run with ``.venv/bin/pytest apps/voice/tests -q``. Every test that talks
to the helper starts it in a subprocess with the fake engine, as the game
apps start it with the real one; the install tests serve fake wheels and
model files from a local HTTP server. All content is synthetic.
"""

from __future__ import annotations

import base64
import hashlib
import http.server
import io
import itertools
import json
import queue
import subprocess
import sys
import threading
import time
import wave
import zipfile
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path

import pytest

VOICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(VOICE_DIR))

MAIN = VOICE_DIR / "kinetic_voice" / "__main__.py"
TIMEOUT = 60.0


def make_wav(seconds: float = 0.5, rate: int = 16000) -> bytes:
    """A short mono 16-bit WAV of a rising ramp: a stand-in reference."""
    frames = bytearray()
    for i in range(int(seconds * rate)):
        frames += int((i % 200) * 100 - 10000).to_bytes(2, "little",
                                                         signed=True)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return out.getvalue()


def read_wav(data: bytes) -> tuple[int, int, int, int]:
    """(channels, sample width, rate, frames) of WAV bytes."""
    with wave.open(io.BytesIO(data), "rb") as w:
        return (w.getnchannels(), w.getsampwidth(), w.getframerate(),
                w.getnframes())


class Helper:
    """A running helper: send requests, read responses and events."""

    def __init__(self, args: list[str]) -> None:
        self.proc = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE)
        self.lines: queue.Queue[dict | None] = queue.Queue()
        self.events: list[dict] = []
        self.responses: dict[object, dict] = {}
        self.order: list[object] = []
        self._ids = itertools.count(1)
        threading.Thread(target=self._read, daemon=True).start()
        self.stderr = b""
        threading.Thread(target=self._drain, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            self.lines.put(json.loads(raw))
        self.lines.put(None)

    def _drain(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr += raw

    def send_raw(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text.encode() + b"\n")
        self.proc.stdin.flush()

    def send(self, op: str, **fields: object) -> object:
        rid = fields.pop("id", None) or next(self._ids)
        self.send_raw(json.dumps({"id": rid, "op": op, **fields}))
        return rid

    def _pump(self, deadline: float) -> bool:
        try:
            msg = self.lines.get(timeout=max(0.0, deadline - time.time()))
        except queue.Empty:
            return False
        if msg is None:
            raise EOFError("helper closed stdout; stderr:\n"
                           + self.stderr.decode(errors="replace"))
        if "event" in msg:
            self.events.append(msg)
        else:
            self.responses[msg.get("id")] = msg
            self.order.append(msg.get("id"))
        return True

    def wait(self, rid: object, timeout: float = TIMEOUT) -> dict:
        deadline = time.time() + timeout
        while rid not in self.responses:
            if not self._pump(deadline):
                raise TimeoutError(f"no response to {rid!r}; stderr:\n"
                                   + self.stderr.decode(errors="replace"))
        return self.responses[rid]

    def request(self, op: str, timeout: float = TIMEOUT,
                **fields: object) -> dict:
        return self.wait(self.send(op, **fields), timeout)

    def wait_event(self, pred: Callable[[dict], bool],
                   timeout: float = TIMEOUT) -> dict:
        deadline = time.time() + timeout
        seen = 0
        while True:
            for ev in self.events[seen:]:
                if pred(ev):
                    return ev
            seen = len(self.events)
            if not self._pump(deadline):
                raise TimeoutError("event not seen")

    def close(self) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
        self.proc.wait(timeout=10)


@pytest.fixture
def start_helper(tmp_path: Path) -> Iterator[Callable[..., Helper]]:
    """Start the helper on a fresh voice folder with the fake engine."""
    started: list[Helper] = []

    def start(*extra: str, root: Path | None = None,
              engine: str = "fake") -> Helper:
        folder = root or tmp_path / "voice"
        folder.mkdir(exist_ok=True)
        args = [sys.executable, "-I", str(MAIN), "--root", str(folder),
                "--engine", engine, *extra]
        helper = Helper(args)
        started.append(helper)
        return helper

    yield start
    for helper in started:
        helper.close()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# The install tests' fake downloads.

def build_wheel(dest: Path, name: str, version: str = "1.0") -> Path:
    """A minimal pure-Python wheel that pip installs for real."""
    filename = f"{name}-{version}-py3-none-any.whl"
    dist = f"{name}-{version}.dist-info"
    files = {
        f"{name}/__init__.py": f"VALUE = {name!r}\n".encode(),
        f"{dist}/METADATA": (f"Metadata-Version: 2.1\nName: {name}\n"
                             f"Version: {version}\n").encode(),
        f"{dist}/WHEEL": (b"Wheel-Version: 1.0\nGenerator: test\n"
                          b"Root-Is-Purelib: true\nTag: py3-none-any\n"),
    }
    record = []
    for path, data in files.items():
        digest = base64.urlsafe_b64encode(
            hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(f"{path},sha256={digest},{len(data)}")
    record.append(f"{dist}/RECORD,,")
    files[f"{dist}/RECORD"] = ("\n".join(record) + "\n").encode()
    path = dest / filename
    with zipfile.ZipFile(path, "w") as z:
        for name_, data in files.items():
            z.writestr(name_, data)
    return path


@dataclass
class FileServer:
    """A local HTTP server for the install tests, with Range support.

    ``files`` maps a URL path to bytes. ``cut_after`` makes the first
    response for a path end after that many bytes (an interrupted
    download); ``slow`` sleeps between chunks so a cancel can land;
    ``ignore_range`` answers a Range request with the whole file.
    """

    files: dict[str, bytes] = field(default_factory=dict)
    cut_after: dict[str, int] = field(default_factory=dict)
    slow: set[str] = field(default_factory=set)
    ignore_range: set[str] = field(default_factory=set)
    requests: list[tuple[str, str | None]] = field(default_factory=list)
    base: str = ""

    def handler(self) -> type[http.server.BaseHTTPRequestHandler]:
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802 (http.server API)
                rng = self.headers.get("Range")
                server.requests.append((self.path, rng))
                data = server.files.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                start = 0
                if rng and self.path not in server.ignore_range:
                    start = int(rng.removeprefix("bytes=").split("-")[0])
                    self.send_response(206)
                    self.send_header(
                        "Content-Range",
                        f"bytes {start}-{len(data) - 1}/{len(data)}")
                else:
                    self.send_response(200)
                body = data[start:]
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                cut = server.cut_after.pop(self.path, None)
                if cut is not None:
                    self.wfile.write(body[:cut])
                    self.wfile.flush()
                    self.connection.close()
                    return
                step = 4096
                for i in range(0, len(body), step):
                    self.wfile.write(body[i:i + step])
                    if self.path in server.slow:
                        self.wfile.flush()
                        time.sleep(0.05)

        return Handler


@pytest.fixture
def file_server() -> Iterator[FileServer]:
    state = FileServer()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0),
                                            state.handler())
    state.base = f"http://127.0.0.1:{httpd.server_address[1]}"
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield state
    httpd.shutdown()
    httpd.server_close()


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_lock(path: Path, server: FileServer, wheels: list[Path],
               model: dict[tuple[str, str], bytes],
               lock_id: str = "test-1") -> dict:
    """Serve the wheels and model files and write a lock naming them."""
    lock = {
        "id": lock_id,
        "python": {"version": "3.12", "url": "", "sha256": "", "size": 0},
        "wheels": [],
        "modelBaseUrl": server.base + "/hf",
        "model": [],
        "engine": {"id": "fake"},
    }
    for wheel in wheels:
        data = wheel.read_bytes()
        server.files["/wheels/" + wheel.name] = data
        lock["wheels"].append({
            "name": wheel.name.split("-")[0],
            "url": server.base + "/wheels/" + wheel.name,
            "sha256": sha(data), "size": len(data)})
    for (repo, file), data in model.items():
        revision = "rev" + repo.replace("/", "")
        server.files[f"/hf/{repo}/resolve/{revision}/{file}"] = data
        lock["model"].append({"repo": repo, "revision": revision,
                              "path": file, "sha256": sha(data),
                              "size": len(data)})
    path.write_text(json.dumps(lock))
    return lock
