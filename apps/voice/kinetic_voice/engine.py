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
from collections.abc import Iterator
from pathlib import Path

SAMPLE_RATE = 24000

#: The languages the engine speaks: Chatterbox multilingual's language ids
#: (its ``SUPPORTED_LANGUAGES``), the same for the MLX and PyTorch builds.
#: A ``speak`` in another is refused. The player keeps the same list
#: (player/src/render/linevoice.ts, ``ENGINE_LANGUAGES``) and
#: tests/test_voice_units.py checks that the two agree.
LANGUAGES = ("ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi",
             "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv",
             "sw", "tr", "zh")

#: Primary language subtags the engine knows by another id: Norwegian
#: Bokmål and Nynorsk are both its ``no``.
_ENGINE_ALIASES = {"nb": "no", "nn": "no"}


def engine_language(tag: str) -> str | None:
    """The engine's id for the BCP 47 tag `tag` (``de``, ``pt-BR``,
    ``zh-Hans``, ``nb``), by its primary language subtag; None when the
    engine does not speak it. The player maps tags the same way
    (linevoice.ts ``engineLanguage``)."""
    primary = tag.split("-", 1)[0].lower()
    primary = _ENGINE_ALIASES.get(primary, primary)
    return primary if primary in LANGUAGES else None


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

    def speak_stream(self, voice: object, text: str,
                     lang: str) -> Iterator[tuple[bytes, int, bool]]:
        """The line in chunks as they are ready: (PCM, sample rate,
        final). The chunks joined are the whole line. By default one
        chunk, the whole line."""
        pcm, rate = self.speak(voice, text, lang)
        yield pcm, rate, True

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
        return {"engine": self.name, "version": 2}

    def load(self) -> None:
        print("fake engine loaded")  # a library print, as mlx_audio makes
        self.loaded = True

    def prepare_voice(self, reference: Path) -> object:
        digest = hashlib.sha256(reference.read_bytes()).digest()
        return 220 + digest[0]  # the voice's pitch in Hz

    #: Seconds of audio in each streamed chunk.
    CHUNK_SECONDS = 0.5

    def speak(self, voice: object, text: str, lang: str) -> tuple[bytes, int]:
        time.sleep(self.delay)
        return self._tone(self._pitch(voice, lang), 0,
                          self._frames(text)), SAMPLE_RATE

    def speak_stream(self, voice: object, text: str,
                     lang: str) -> Iterator[tuple[bytes, int, bool]]:
        """The same tone as ``speak``, in CHUNK_SECONDS pieces, the delay
        spread over them."""
        frames = self._frames(text)
        pitch = self._pitch(voice, lang)
        step = int(SAMPLE_RATE * self.CHUNK_SECONDS)
        starts = range(0, frames, step)
        for start in starts:
            time.sleep(self.delay / len(starts))
            end = min(start + step, frames)
            yield (self._tone(pitch, start, end), SAMPLE_RATE,
                   end == frames)

    @staticmethod
    def _pitch(voice: object, lang: str) -> float:
        """The voice's pitch: as it is for English, raised a little by
        each other language's place in LANGUAGES, so a test can tell
        which language a line was made in."""
        step = 0 if lang == "en" or lang not in LANGUAGES \
            else 1 + LANGUAGES.index(lang)
        return float(voice) + 7 * step  # type: ignore[arg-type]

    @staticmethod
    def _frames(text: str) -> int:
        return int(SAMPLE_RATE * (0.2 + 0.05 * len(text)))

    @staticmethod
    def _tone(pitch: float, start: int, end: int) -> bytes:
        step = 2 * math.pi * pitch / SAMPLE_RATE
        return array.array("h", (int(8000 * math.sin(step * i))
                                 for i in range(start, end))).tobytes()


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
    if name == "chatterbox-torch":
        from .engine_torch import ChatterboxTorch
        return ChatterboxTorch(root, lock)
    raise ValueError(f"unknown engine {name!r}")
