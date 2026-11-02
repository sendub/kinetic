"""Decoder hooks: ``--decoder MODULE:FUNC`` (docs/plan.md Phase 25).

A hook undoes a game-specific wrapper or obfuscation. It ships with the
game's conversion package, not with Kinetic, and runs in-process with the
converter's own trust. Contract (docs/extracting.md, "Decoder hooks"):

- ``FUNC(data: bytes, source: dict) -> bytes | None``, called with the
  COMPLETE bytes of every media source the asset pass reads, loose file
  or archive member, before format detection or carving. ``source`` is a
  copy of the source ref: ``{"path": "game/..."}`` or ``{"archive":
  "game/x.rpa", "member": "..."}``.
- ``None`` means unchanged. Returned bytes replace the data.
- A hook that recognises its format but finds the data malformed raises;
  the run then stops, naming the hook, the source and the error. Nothing
  is silently skipped.
- Several hooks chain in the order given: each gets the previous one's
  output, so a hook may unwrap what an earlier hook exposed, and hooks
  for unrelated formats coexist by returning ``None`` for data that is
  not theirs.

Each hook that changed a source adds a ``decode`` step (hook as given,
sha256 of its source file, input and output sha256) to the ledger; the
run's hooks are listed under the ledger's ``decoders``.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

Hook = Callable[[bytes, dict[str, Any]], Any]


class DecoderError(RuntimeError):
    """A hook could not be loaded, raised, or returned something other
    than bytes or None."""


@dataclass(frozen=True)
class Decoder:
    spec: str          # MODULE:FUNC exactly as given on the command line
    func: Hook
    sha256: str        # sha256 of the hook's source file

    def record(self) -> dict[str, str]:
        """The ledger's ``decoders`` entry for this hook."""
        return {"hook": self.spec, "hookSha256": self.sha256}


def _is_path(module: str) -> bool:
    return module.endswith(".py") or "/" in module or "\\" in module


def _load_module(module: str) -> Any:
    if not _is_path(module):
        return importlib.import_module(module)
    path = Path(module).expanduser().resolve()
    if not path.is_file():
        raise DecoderError(f"no such file {module!r}")
    name = "_kinetic_decoder_" + hashlib.sha256(
        str(path).encode("utf-8")).hexdigest()[:16]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise DecoderError(f"cannot load {module!r} as a Python module")
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def load_decoder(spec: str) -> Decoder:
    """Import the hook ``MODULE:FUNC``; MODULE is an importable module
    name or a path to a ``.py`` file (the last ``:`` separates FUNC)."""
    module, sep, func_name = spec.rpartition(":")
    if not sep or not module or not func_name:
        raise DecoderError(f"{spec!r} is not MODULE:FUNC")
    try:
        loaded = _load_module(module)
    except DecoderError:
        raise
    except Exception as exc:  # noqa: BLE001 - any import failure is fatal
        raise DecoderError(
            f"cannot import {module!r}: {type(exc).__name__}: {exc}"
        ) from exc
    func = getattr(loaded, func_name, None)
    if not callable(func):
        raise DecoderError(f"{module!r} has no function {func_name!r}")
    try:
        source_file = inspect.getsourcefile(loaded) or loaded.__file__
        code = Path(source_file).read_bytes()
    except (TypeError, OSError, AttributeError) as exc:
        raise DecoderError(
            f"cannot read the source file of {module!r} to hash it") from exc
    return Decoder(spec, func, hashlib.sha256(code).hexdigest())


def describe(source: dict[str, Any]) -> str:
    """A source ref as one string (the ledger item ``asset`` form)."""
    if "archive" in source:
        return f"{source['archive']}!{source['member']}"
    return str(source["path"])


def apply(decoders: list[Decoder], data: bytes,
          source: dict[str, Any]) -> tuple[bytes, list[dict[str, Any]]]:
    """Run every hook over ``data`` in order; returns the decoded bytes and
    one ledger ``decode`` step per hook that changed them."""
    steps: list[dict[str, Any]] = []
    for decoder in decoders:
        try:
            out = decoder.func(data, dict(source))
        except Exception as exc:  # noqa: BLE001 - reported, run stops
            raise DecoderError(
                f"decoder hook {decoder.spec} failed on {describe(source)}: "
                f"{type(exc).__name__}: {exc}") from exc
        if out is None:
            continue
        if not isinstance(out, (bytes, bytearray, memoryview)):
            raise DecoderError(
                f"decoder hook {decoder.spec} returned "
                f"{type(out).__name__} for {describe(source)}; expected "
                "bytes or None")
        out = bytes(out)
        if out == data:
            continue
        steps.append({"step": "decode", "hook": decoder.spec,
                      "hookSha256": decoder.sha256,
                      "inputSha256": hashlib.sha256(data).hexdigest(),
                      "outputSha256": hashlib.sha256(out).hexdigest()})
        data = out
    return data, steps
