"""The JSON-lines protocol: requests on stdin, answers and events on
stdout. README.md beside the package describes it.

The main thread reads requests and answers the quick ones itself. The
install runs on its own thread, and the engine (loading, voices, lines,
remove) on one engine thread fed by a JobQueue, so status and cancel are
answered while either works. Every line out goes through ``send``, under
one lock, so lines never interleave.
"""

from __future__ import annotations

import base64
import binascii
import json
import threading
import time
import traceback
from pathlib import Path
from typing import BinaryIO

from .cache import FORMATS, LineCache, VoiceStore, line_key
from .engine import Engine, pcm_to_wav
from .install import Installer, InstallError
from .jobs import JobQueue


class RequestError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Server:
    def __init__(self, root: Path, installer: Installer, engine: Engine,
                 out: BinaryIO) -> None:
        self.root = root
        self.installer = installer
        self.engine = engine
        self.out = out
        self._write = threading.Lock()
        self.lines = LineCache(root / "cache" / "lines")
        self.voices = VoiceStore(root / "cache" / "voices")
        self.handles: dict[str, object] = {}  # engine thread only
        self.jobs = JobQueue()
        self.install_id: object = None
        self.install_thread: threading.Thread | None = None
        self.install_cancel = threading.Event()
        self.removing = False
        installer.emit = self.send
        threading.Thread(target=self._engine_loop, daemon=True).start()

    # Output

    def send(self, msg: dict) -> None:
        data = (json.dumps(msg, separators=(",", ":")) + "\n").encode()
        with self._write:
            self.out.write(data)
            self.out.flush()

    def reply(self, rid: object, **fields: object) -> None:
        self.send({"id": rid, "ok": True, **fields})

    def fail(self, rid: object, code: str, error: str) -> None:
        self.send({"id": rid, "ok": False, "error": error, "code": code})

    def log(self, message: str, **fields: object) -> None:
        self.send({"event": "log", "message": message, **fields})

    # Input

    def serve(self, stdin: BinaryIO) -> None:
        """Answer requests until ``quit`` or the end of input."""
        for raw in stdin:
            if not raw.strip():
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                self.fail(None, "bad-request", "a request must be JSON")
                continue
            rid = msg.get("id") if isinstance(msg, dict) else None
            op = msg.get("op") if isinstance(msg, dict) else None
            if not isinstance(op, str):
                self.fail(rid, "bad-request", "a request needs an op")
                continue
            if op == "quit":
                self.reply(rid)
                break
            handler = self.OPS.get(op)
            if handler is None:
                self.fail(rid, "unknown-op", f"unknown op {op!r}")
                continue
            try:
                handler(self, rid, msg)
            except RequestError as err:
                self.fail(rid, err.code, str(err))
        self.stop()

    def stop(self) -> None:
        """Stop an install cleanly (its partial files stay for resume)."""
        self.install_cancel.set()
        if self.install_thread is not None:
            self.install_thread.join(timeout=10)

    # Ops answered on the reading thread

    def op_status(self, rid: object, msg: dict) -> None:
        try:
            status = self.installer.status()
        except ValueError as err:
            raise RequestError("unsupported-system", str(err)) from None
        self.reply(rid, **status, engine=self.engine.name,
                   warm=self.engine.loaded,
                   installing=self._installing(), **self.engine.stats())

    def _installing(self) -> bool:
        return (self.install_thread is not None
                and self.install_thread.is_alive())

    def op_install(self, rid: object, msg: dict) -> None:
        if self._installing() or self.removing:
            raise RequestError("busy", "an install or remove is running")
        self.install_id = rid
        self.install_cancel = threading.Event()
        self.install_thread = threading.Thread(
            target=self._install, args=(rid, self.install_cancel),
            daemon=True)
        self.install_thread.start()

    def _install(self, rid: object, cancel: threading.Event) -> None:
        try:
            result = self.installer.run(cancel)
        except InstallError as err:
            self.fail(rid, err.code, str(err))
        except ValueError as err:
            self.fail(rid, "unsupported-system", str(err))
        except Exception as err:  # noqa: BLE001 (answer, never hang)
            traceback.print_exc()
            self.fail(rid, "install-failed", f"{type(err).__name__}: {err}")
        else:
            self.reply(rid, **result)

    def op_cancel(self, rid: object, msg: dict) -> None:
        target = msg.get("target")
        if target is not None and target == self.install_id and (
                self._installing()):
            self.install_cancel.set()
            self.reply(rid, cancelled=True)
            return
        if self.jobs.cancel(target) is not None:
            self.fail(target, "cancelled", "cancelled")
            self.reply(rid, cancelled=True)
            return
        self.reply(rid, cancelled=False, state=self.jobs.state(target))

    def op_remove(self, rid: object, msg: dict) -> None:
        if self._installing():
            raise RequestError("busy", "an install is running")
        self.removing = True
        self.jobs.put(rid, ("remove",), control=True)

    def op_warm(self, rid: object, msg: dict) -> None:
        self.jobs.put(rid, ("warm",), control=True)

    def op_voice(self, rid: object, msg: dict) -> None:
        fmt = msg.get("format", "wav")
        if fmt not in FORMATS:
            raise RequestError("bad-request",
                               f"format must be one of {', '.join(FORMATS)}")
        try:
            data = base64.b64decode(msg.get("voice") or "", validate=True)
        except (binascii.Error, TypeError):
            raise RequestError("bad-request", "voice must be base64") from None
        if not data:
            raise RequestError("bad-request", "voice is empty")
        voice_id, path = self.voices.add(data, fmt)
        self.jobs.put(rid, ("voice", voice_id, path), control=True)

    def op_speak(self, rid: object, msg: dict) -> None:
        voice_id, text = msg.get("voiceId"), msg.get("text")
        lang, priority = msg.get("lang", "en"), msg.get("priority", 0)
        if not isinstance(text, str) or not text.strip():
            raise RequestError("bad-request", "text is empty")
        if not isinstance(voice_id, str) or not isinstance(lang, str):
            raise RequestError("bad-request", "voiceId and lang are strings")
        if not isinstance(priority, int):
            raise RequestError("bad-request", "priority is an integer")
        key = line_key(self.engine.identity(), voice_id, text, lang)
        hit = self.lines.get(key)
        if hit is not None:
            wav, seconds = hit
            self.reply(rid, wav=base64.b64encode(wav).decode(),
                       seconds=seconds, genSeconds=0, cached=True)
            self.jobs.done(rid)
            return
        if voice_id not in self.handles and self.voices.find(voice_id) is None:
            raise RequestError("unknown-voice", "no voice with that voiceId")
        self.jobs.put(rid, ("speak", voice_id, text, lang, key), priority)

    OPS = {"status": op_status, "install": op_install, "cancel": op_cancel,
           "remove": op_remove, "warm": op_warm, "voice": op_voice,
           "speak": op_speak}

    # The engine thread

    def _engine_loop(self) -> None:
        while True:
            rid, job = self.jobs.get()
            try:
                self._run(rid, job)  # type: ignore[arg-type]
            except RequestError as err:
                self.fail(rid, err.code, str(err))
            except Exception as err:  # noqa: BLE001 (answer, never hang)
                traceback.print_exc()
                self.fail(rid, "engine-failed",
                          f"{type(err).__name__}: {err}")
            finally:
                self.jobs.done(rid)

    def _run(self, rid: object, job: tuple) -> None:
        kind = job[0]
        if kind == "remove":
            try:
                self.engine.unload()
                self.handles.clear()
                self.installer.remove()
            finally:
                self.removing = False
            self.reply(rid)
        elif kind == "warm":
            self.reply(rid, loadSeconds=self._ensure_loaded())
        elif kind == "voice":
            _, voice_id, path = job
            self._ensure_loaded()
            self._handle(voice_id, path)
            self.reply(rid, voiceId=voice_id)
        elif kind == "speak":
            _, voice_id, text, lang, key = job
            self.log("speaking", target=rid)
            self._ensure_loaded()
            handle = self._handle(voice_id, self.voices.find(voice_id))
            started = time.perf_counter()
            pcm, rate = self.engine.speak(handle, text, lang)
            gen = time.perf_counter() - started
            wav = pcm_to_wav(pcm, rate)
            seconds = round(len(pcm) / 2 / rate, 3)
            self.lines.put(key, wav, seconds)
            self.reply(rid, wav=base64.b64encode(wav).decode(),
                       seconds=seconds, genSeconds=round(gen, 3),
                       cached=False)

    def _ensure_loaded(self) -> float:
        if self.engine.loaded:
            return 0.0
        if self.engine.requires_install and not self.installer.installed():
            raise RequestError("not-installed",
                               "the voice model is not installed")
        started = time.perf_counter()
        self.log("loading engine", engine=self.engine.name)
        self.engine.load()
        seconds = round(time.perf_counter() - started, 2)
        self.log("engine loaded", seconds=seconds)
        return seconds

    def _handle(self, voice_id: str, path: Path | None) -> object:
        if voice_id not in self.handles:
            if path is None:
                raise RequestError("unknown-voice",
                                   "no voice with that voiceId")
            started = time.perf_counter()
            self.handles[voice_id] = self.engine.prepare_voice(path)
            self.log("voice prepared", voiceId=voice_id,
                     seconds=round(time.perf_counter() - started, 2))
        return self.handles[voice_id]
