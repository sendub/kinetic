"""The speech engine seam, the fake engine and the WAV writer.

An engine turns a reference clip into a voice handle and a line of text
into 16-bit mono PCM. The helper calls every engine method on its one
engine thread. Engines import their heavy packages in ``load`` only, so
the rest of the helper runs on the standard library before the install.
"""

from __future__ import annotations

import array
import hashlib
import io
import math
import time
import wave
from pathlib import Path

SAMPLE_RATE = 24000


class Engine:
    """What the helper needs from a speech engine."""

    name = "engine"
    #: Whether the engine needs the lock's packages and model installed.
    requires_install = True

    def __init__(self, root: Path, lock: dict) -> None:
        self.root = root
        self.lock = lock
        self.loaded = False

    def identity(self) -> dict:
        """Everything that changes the audio, for the line cache key."""
        raise NotImplementedError

    def load(self) -> None:
        """Load the model; called once before the first voice or line."""
        raise NotImplementedError

    def unload(self) -> None:
        self.loaded = False

    def prepare_voice(self, reference: Path) -> object:
        """A handle for the voice in this reference clip (wav, flac or
        mp3, by extension)."""
        raise NotImplementedError

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        """(little-endian int16 mono PCM, sample rate) for one line."""
        raise NotImplementedError

    def stats(self) -> dict:
        """Extra fields for ``status`` (memory use, say)."""
        return {}


class FakeEngine(Engine):
    """A deterministic tone, longer for longer text. For tests and for the
    apps' driver tests; ``delay`` stands in for generation time."""

    name = "fake"
    requires_install = False

    def __init__(self, root: Path, lock: dict, delay: float = 0.0) -> None:
        super().__init__(root, lock)
        self.delay = delay

    def identity(self) -> dict:
        return {"engine": self.name, "version": 1}

    def load(self) -> None:
        print("fake engine loaded")  # a library print, as mlx_audio makes
        self.loaded = True

    def prepare_voice(self, reference: Path) -> object:
        digest = hashlib.sha256(reference.read_bytes()).digest()
        return 220 + digest[0]  # the voice's pitch in Hz

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        time.sleep(self.delay)
        frames = int(SAMPLE_RATE * (0.2 + 0.05 * len(text)))
        pitch = float(voice)  # type: ignore[arg-type]
        step = 2 * math.pi * pitch / SAMPLE_RATE
        pcm = array.array("h", (int(8000 * math.sin(step * i))
                                for i in range(frames)))
        return pcm.tobytes(), SAMPLE_RATE


def pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    """A WAV file around little-endian int16 mono PCM."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def create_engine(name: str, root: Path, lock: dict,
                  fake_delay: float = 0.0) -> Engine:
    if name == "fake":
        return FakeEngine(root, lock, fake_delay)
    if name == "chatterbox-mlx":
        from .engine_mlx import ChatterboxMLX
        return ChatterboxMLX(root, lock)
    raise ValueError(f"unknown engine {name!r}")
