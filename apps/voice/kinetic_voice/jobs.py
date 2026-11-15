"""The engine thread's job queue.

Control jobs (warm, voice, remove) go first, in arrival order. Lines go
after them, highest priority first and in arrival order within a
priority. A queued job can be cancelled; a running one cannot.
"""

from __future__ import annotations

import heapq
import itertools
import threading


class JobQueue:
    def __init__(self) -> None:
        self._heap: list[tuple[int, int, int, object, object]] = []
        self._queued: dict[object, object] = {}
        self._running: set[object] = set()
        self._done: set[object] = set()
        self._seq = itertools.count()
        self._cond = threading.Condition()

    def put(self, rid: object, job: object, priority: int = 0,
            control: bool = False) -> None:
        with self._cond:
            heapq.heappush(self._heap, (0 if control else 1, -priority,
                                        next(self._seq), rid, job))
            self._queued[rid] = job
            self._cond.notify()

    def get(self) -> tuple[object, object]:
        """The next job, waiting for one; it is then running."""
        with self._cond:
            while True:
                while self._heap:
                    *_, rid, job = heapq.heappop(self._heap)
                    if self._queued.get(rid) is job:
                        del self._queued[rid]
                        self._running.add(rid)
                        return rid, job
                self._cond.wait()

    def done(self, rid: object) -> None:
        with self._cond:
            self._running.discard(rid)
            self._done.add(rid)

    def cancel(self, rid: object) -> object | None:
        """The dropped job, or None when it is not queued."""
        with self._cond:
            return self._queued.pop(rid, None)

    def state(self, rid: object) -> str:
        with self._cond:
            if rid in self._queued:
                return "queued"
            if rid in self._running:
                return "running"
            if rid in self._done:
                return "done"
            return "unknown"
