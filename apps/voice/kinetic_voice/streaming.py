"""Streaming a line: when to cut it into chunks, and how the chunks join.

Engine-side (it uses numpy, which the install brings); kept apart from
``engine_mlx`` so the tests can run it without MLX.

A streamed line is decoded again at each cut from the voice's prompt and
the speech tokens before it (CosyVoice2's scheme, which Chatterbox's
decoder comes from): the flow keeps the mel frames from the previous cut
on, the vocoder renders the end of the previous chunk again from the same
mel frames and source signal, and ``Joiner`` crossfades ``overlap``
samples of that second rendering with what the previous chunk held back.
The two renderings are nearly the same audio (``engine_mlx`` says how
near), so the join has no click and no dip.
"""

from __future__ import annotations

import math

TOKENS_PER_SECOND = 25  # the S3 speech tokens' rate


class ChunkPlan:
    """When to decode the next chunk of a line, counted in speech tokens.

    The first chunk comes after ``first`` seconds of tokens, the next
    after ``chunk`` seconds more, and each later one ``growth`` times the
    one before (capped at ``limit`` seconds), so a long line costs few
    decodes. Each cut also waits for ``lookahead`` tokens past it, which
    the decoder's encoder needs to finish the frames before the cut.
    """

    def __init__(self, first: float, chunk: float, growth: float = 1.0,
                 limit: float = 8.0, lookahead: int = 3) -> None:
        self.lookahead = lookahead
        self._next = max(1, round(first * TOKENS_PER_SECOND))
        self._size = chunk * TOKENS_PER_SECOND
        self._growth = growth
        self._limit = limit * TOKENS_PER_SECOND
        self.done = 0  # tokens already decoded into emitted mel

    def due(self, tokens: int) -> bool:
        """Whether ``tokens`` tokens so far call for a chunk now."""
        return tokens - self.done >= self._next + self.lookahead

    def cut(self, tokens: int) -> int:
        """Record a chunk cut with ``tokens`` tokens generated; returns the
        tokens its mel covers up to (the lookahead stays for the next)."""
        self.done = tokens - self.lookahead
        self._next = max(1, round(self._size))
        self._size = min(self._size * self._growth, self._limit)
        return self.done


def fades(overlap: int):
    """Complementary raised-cosine fades (fade-in, fade-out) whose sum is
    1 at every sample: an equal-gain crossfade, right for two renderings
    of the same audio."""
    import numpy as np
    t = (np.arange(overlap, dtype=np.float64) + 0.5) / overlap
    fade_in = np.sin(0.5 * math.pi * t) ** 2
    return fade_in.astype(np.float32), (1.0 - fade_in).astype(np.float32)


class Joiner:
    """Joins rendered chunks into gap-free audio to send.

    Every chunk after the first starts with ``overlap`` samples that
    render the same audio as the previous chunk's last ``overlap``
    samples. ``push`` holds those back from each chunk but the final one
    and crossfades them into the next chunk's start.
    """

    def __init__(self, overlap: int) -> None:
        self.overlap = overlap
        self._fade_in, self._fade_out = fades(overlap)
        self._tail = None

    def push(self, wav, final: bool):
        """The samples of ``wav`` (float32, mono) ready to send."""
        import numpy as np
        wav = np.asarray(wav, dtype=np.float32).copy()
        if self._tail is not None:
            k = min(self.overlap, len(wav))
            wav[:k] = (wav[:k] * self._fade_in[:k]
                       + self._tail[:k] * self._fade_out[:k])
            if k < self.overlap:  # a final chunk shorter than the overlap
                wav = np.concatenate([wav, self._tail[k:]
                                      * self._fade_out[k:]])
        if final:
            self._tail = None
            return wav
        keep = min(self.overlap, len(wav))
        self._tail = wav[len(wav) - keep:].copy()
        if keep < self.overlap:
            self._tail = np.concatenate(
                [np.zeros(self.overlap - keep, np.float32), self._tail])
        return wav[:len(wav) - keep]
