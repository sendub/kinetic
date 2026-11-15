"""Streaming's pure parts: the chunk plan and the crossfaded joins."""

from __future__ import annotations

import numpy as np
from kinetic_voice.streaming import ChunkPlan, Joiner, fades


def tone(n: int, start: int = 0) -> np.ndarray:
    i = np.arange(start, start + n)
    return (0.5 * np.sin(2 * np.pi * 180 * i / 24000)).astype(np.float32)


def test_fades_sum_to_one():
    fade_in, fade_out = fades(3840)
    assert np.allclose(fade_in + fade_out, 1.0, atol=1e-6)
    assert fade_in[0] < 0.01 and fade_in[-1] > 0.99


def test_overlapping_renders_of_one_signal_join_back_into_it():
    whole = tone(24000 * 3)
    overlap = 3840
    cuts = [0, 20000, 41000, len(whole)]
    joiner = Joiner(overlap)
    out = []
    for n, (a, b) in enumerate(zip(cuts, cuts[1:])):
        start = a - overlap if n else a  # later renders repeat the overlap
        out.append(joiner.push(whole[start:b], final=b == len(whole)))
    joined = np.concatenate(out)
    assert len(joined) == len(whole)
    assert np.allclose(joined, whole, atol=1e-5)
    # Each piece sent before the last holds its overlap back.
    assert [len(p) for p in out] == [20000 - overlap, 21000, len(whole)
                                     - 41000 + overlap]


def test_a_join_between_different_renders_has_no_jump():
    # The second render of the overlap is out of phase: the crossfade
    # still moves from one to the other without a step.
    overlap = 3840
    joiner = Joiner(overlap)
    a = joiner.push(tone(12000), final=False)
    b = joiner.push(tone(12000, start=12000 - overlap + 60), final=True)
    joined = np.concatenate([a, b])
    step = np.abs(np.diff(joined))
    assert step.max() < 2.5 * np.abs(np.diff(tone(12000))).max()


def test_the_plan_cuts_after_first_then_each_chunk_with_lookahead():
    plan = ChunkPlan(first=1.0, chunk=2.0, lookahead=3)
    due = [n for n in range(1, 200) if plan.due(n) and plan.cut(n) >= 0]
    assert due == [28, 78, 128, 178]
    assert plan.done == 175


def test_the_plan_grows_its_chunks_up_to_the_limit():
    plan = ChunkPlan(first=1.0, chunk=1.0, growth=2.0, limit=4.0,
                     lookahead=3)
    due = [n for n in range(1, 400) if plan.due(n) and plan.cut(n) >= 0]
    # 25 tokens, then 25, 50, 100, 100 (4 s cap), ...
    assert due == [28, 53, 103, 203, 303]
