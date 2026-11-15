"""Reading the app's requests from stdin.

On Windows a thread blocked in a synchronous read of a pipe holds that
pipe's file object, and loading a native library on another thread
(numpy's, PyTorch's) can query the standard handles at its start and
wait behind the read forever: the engine thread's first ``import torch``
never returned. So on Windows, when stdin is a pipe, requests are read by
polling it with ``PeekNamedPipe``, which leaves no read pending.
Everywhere else this is plain line iteration.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterable, Iterator
from typing import BinaryIO

POLL_SECONDS = 0.05
FILE_TYPE_PIPE = 3


def lines_from_chunks(chunks: Iterable[bytes]) -> Iterator[bytes]:
    """Lines (with their newline) from byte chunks cut anywhere; an
    unterminated last line is yielded as it is."""
    buffer = b""
    for chunk in chunks:
        buffer += chunk
        while True:
            line, newline, rest = buffer.partition(b"\n")
            if not newline:
                break
            yield line + newline
            buffer = rest
    if buffer:
        yield buffer


def input_lines(stream: BinaryIO) -> Iterator[bytes]:
    if os.name == "nt":
        chunks = _polled_chunks(stream)
        if chunks is not None:
            yield from lines_from_chunks(chunks)
            return
    yield from stream


def _polled_chunks(stream: BinaryIO) -> Iterator[bytes] | None:
    """Chunks as they arrive on a Windows pipe, or ``None`` when the
    stream is not one (a file or a console)."""
    import ctypes
    import msvcrt
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetFileType.argtypes = [wintypes.HANDLE]
    kernel32.GetFileType.restype = wintypes.DWORD
    kernel32.PeekNamedPipe.argtypes = [
        wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD)]
    kernel32.PeekNamedPipe.restype = wintypes.BOOL
    fd = stream.fileno()
    handle = msvcrt.get_osfhandle(fd)
    if kernel32.GetFileType(handle) != FILE_TYPE_PIPE:
        return None

    def chunks() -> Iterator[bytes]:
        available = wintypes.DWORD()
        while True:
            if not kernel32.PeekNamedPipe(
                    handle, None, 0, None, ctypes.byref(available), None):
                return  # the writer closed the pipe
            if available.value == 0:
                time.sleep(POLL_SECONDS)
                continue
            data = os.read(fd, available.value)  # cannot block now
            if not data:
                return
            yield data
    return chunks()
