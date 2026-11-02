"""SYNTHETIC decoder hooks for the `--decoder` tests (docs/plan.md Phase 25,
item 25.4).

`decode` applies the "EXTRA" wrapper formula a converting agent reported,
purely to exercise the hook mechanism on synthetic files. It is NOT a
correct decoder for any game (game I episodes 4-5 use an
activation-dependent offset); the real hook lives in that game's
conversion package, not in Kinetic.

`wrap` is its inverse, for building test files. `unreverse` is a second,
equally made-up wrapper used to test hook order.
"""

from __future__ import annotations

PREFIX = b"EXTRA"
HEAD = 8          # prefix plus three bytes the wrapper adds
JUNK = 10         # bytes inserted at the length-dependent offset
STRIDE = 30477


def _offset(wrapped_len: int) -> int:
    return max(20, ((wrapped_len - 18) // STRIDE) * STRIDE)


def decode(data: bytes, source: dict) -> bytes | None:
    """Unwrap an EXTRA file; None (unchanged) for anything else. Raises on
    an EXTRA file too short to hold the wrapper."""
    if not data.startswith(PREFIX):
        return None
    offset = _offset(len(data))
    if len(data) < offset + JUNK:
        raise ValueError(f"truncated EXTRA wrapper ({len(data)} bytes)")
    return data[HEAD:offset] + data[offset + JUNK:]


def wrap(payload: bytes) -> bytes:
    """The EXTRA-wrapped file that `decode` turns back into `payload`."""
    offset = _offset(len(payload) + HEAD + JUNK)
    cut = offset - HEAD
    return (PREFIX + b"\x01\x02\x03" + payload[:cut] + b"J" * JUNK
            + payload[cut:])


REV = b"REV!"


def unreverse(data: bytes, source: dict) -> bytes | None:
    """`REV!` + reversed payload -> payload; None for anything else."""
    if not data.startswith(REV):
        return None
    return data[len(REV):][::-1]


def unreverse_wrap(payload: bytes) -> bytes:
    return REV + payload[::-1]


SEEN: list[dict] = []


def record_sources(data: bytes, source: dict) -> None:
    """Remember every source it is called with; changes nothing."""
    SEEN.append(dict(source, bytes=len(data)))
    return None
