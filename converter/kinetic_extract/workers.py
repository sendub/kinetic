"""Bounded worker threads for ``kinetic-media ship`` and ``rebuild``
(``--jobs``, ``--video-jobs``; docs/extracting.md, "Parallel workers").

The slow work (lossless JPEG XL at effort 9, ffmpeg frames and
transcodes, Pillow PNG saves) runs in libjxl, zlib or a child process,
all of which release the GIL, so threads give real concurrency without
pickling frames between processes. Each encode stays single-threaded
(``numthreads=1``, ``-threads 1``); concurrency comes from running
several at once.

``Workers`` runs at most ``jobs`` tasks at a time in all. Video
transcodes and remuxes go in their own lane, at most ``video_jobs`` at
a time, and take the next free slot before any waiting still-image
task, so a long transcode starts early instead of after every poster.
Tasks are keyed: one key is submitted once, so work shared by several
requests runs once.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable, Hashable
from concurrent.futures import Future, ThreadPoolExecutor
from typing import Any, TextIO

# Measured on an 8-core M2 (4 performance + 4 efficiency cores, 16 GB):
# 1080p posters scale up to one task per core, each JPEG XL encode
# needing about 0.12 GB (docs/extracting.md, "Parallel workers").
VIDEO_SHARE = 4


def default_jobs() -> int:
    """One task per core."""
    return max(1, os.cpu_count() or 1)


def default_video_jobs(jobs: int) -> int:
    """A quarter of `jobs` (at least one) for transcodes and remuxes."""
    return max(1, jobs // VIDEO_SHARE)


class _Slots:
    """`total` run slots; video waiters are served first."""

    def __init__(self, total: int) -> None:
        self._free = total
        self._video_waiting = 0
        self._cond = threading.Condition()

    def acquire(self, video: bool) -> None:
        with self._cond:
            if video:
                self._video_waiting += 1
                self._cond.wait_for(lambda: self._free > 0)
                self._video_waiting -= 1
            else:
                self._cond.wait_for(
                    lambda: self._free > 0 and not self._video_waiting)
            self._free -= 1

    def release(self) -> None:
        with self._cond:
            self._free += 1
            self._cond.notify_all()


class Workers:
    """Keyed tasks on at most `jobs` threads, video ones at most
    `video_jobs` at a time. Use as a context manager: leaving it waits
    for running tasks and drops queued ones."""

    def __init__(self, jobs: int, video_jobs: int) -> None:
        if jobs < 1 or video_jobs < 1:
            raise ValueError("jobs and video_jobs must be >= 1")
        self.jobs = jobs
        self.video_jobs = min(video_jobs, jobs)
        self._slots = _Slots(jobs)
        self._pool = ThreadPoolExecutor(jobs, "kinetic-job")
        self._video = ThreadPoolExecutor(self.video_jobs, "kinetic-video")
        self._futures: dict[Hashable, Future[Any]] = {}

    def __enter__(self) -> Workers:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        for pool in (self._pool, self._video):
            pool.shutdown(wait=True, cancel_futures=True)

    def submit(self, key: Hashable, fn: Callable[..., Any], *args: Any,
               video: bool = False) -> bool:
        """Queue ``fn(*args)`` under `key`; False (nothing queued) when
        that key was already submitted."""
        if key in self._futures:
            return False
        pool = self._video if video else self._pool
        self._futures[key] = pool.submit(self._run, video, fn, args)
        return True

    def _run(self, video: bool, fn: Callable[..., Any],
             args: tuple[Any, ...]) -> Any:
        self._slots.acquire(video)
        try:
            return fn(*args)
        finally:
            self._slots.release()

    def has(self, key: Hashable) -> bool:
        return key in self._futures

    def result(self, key: Hashable) -> Any:
        """Wait for `key`'s task and return its result (re-raising its
        exception). KeyError when it was never submitted."""
        return self._futures[key].result()


class Progress:
    """``label: done/total`` lines on `stream`, at most one per
    `interval` seconds, plus the last one, with elapsed time and an
    estimate of the time left."""

    def __init__(self, label: str, total: int, stream: TextIO,
                 interval: float = 10.0) -> None:
        self.label = label
        self.total = total
        self.stream = stream
        self.interval = interval
        self.start = time.monotonic()
        self._last = self.start

    def __call__(self, done: int) -> None:
        now = time.monotonic()
        if done < self.total and now - self._last < self.interval:
            return
        self._last = now
        elapsed = now - self.start
        line = f"{self.label}: {done}/{self.total}"
        if self.total:
            line += f" ({100 * done / self.total:.1f}%)"
        line += f", {_clock(elapsed)} elapsed"
        if 0 < done < self.total:
            line += f", ~{_clock(elapsed * (self.total - done) / done)} left"
        print(line, file=self.stream, flush=True)


def _clock(seconds: float) -> str:
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    minutes, secs = divmod(rest, 60)
    return (f"{hours}h{minutes:02d}m" if hours else
            f"{minutes}m{secs:02d}s" if minutes else f"{secs}s")
