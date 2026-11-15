"""Decompile compiled-only ``.rpyc`` sources to ``.rpy`` text in memory.

Compiled-only Ren'Py releases ship ``*.rpyc`` with no ``*.rpy`` (game D in
docs/extracting.md's corpus survey is one). The corpus is
read-only, so decompilation never writes next to the input: the vendored
unrpyc package renders the AST to text in a buffer and that text is
cached under ``.tmp/kinetic-decompile/`` keyed by ``(path, mtime, size)``
so repeated runs skip the work. The pin, the vendored files, and the
import-vs-subprocess choice are documented in ``converter/vendor/SOURCES.md``.

The module is imported lazily (``ensure_loaded``) and only used when a
project actually contains an orphan ``.rpyc``, so projects that already
have ``.rpy`` sources pay nothing.
"""

from __future__ import annotations

import hashlib
import io
import sys
from pathlib import Path

# converter/vendor/unrpyc, relative to this installed module
# (kinetic_extract/rpyc.py -> kinetic_extract -> converter -> repo root,
# but the vendor dir is under converter/, one level above this package).
_VENDOR_DIR = Path(__file__).resolve().parent.parent / "vendor" / "unrpyc"

_unrpyc = None
_decompiler = None


class RpycError(RuntimeError):
    """Raised when a .rpyc cannot be decompiled or unrpyc is unavailable."""


def _default_cache_dir() -> Path:
    """Repo ``.tmp/kinetic-decompile`` (overridable for tests)."""
    import os
    env = os.environ.get("KINETIC_DECOMPILE_CACHE")
    if env:
        return Path(env)
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / ".tmp" / "kinetic-decompile"


def ensure_loaded():
    """Import the vendored unrpyc package, adding its dir to sys.path."""
    global _unrpyc, _decompiler
    if _unrpyc is not None:
        return _unrpyc, _decompiler
    if not _VENDOR_DIR.is_dir():
        raise RpycError(f"vendored unrpyc not found at {_VENDOR_DIR}")
    vendor = str(_VENDOR_DIR)
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    try:
        import unrpyc  # type: ignore
        import decompiler  # type: ignore
    except Exception as exc:  # pragma: no cover - import-time environment
        raise RpycError(f"cannot import vendored unrpyc: {exc}") from exc
    _unrpyc, _decompiler = unrpyc, decompiler
    return unrpyc, decompiler


def _cache_file(rpyc: Path, cache_dir: Path) -> Path:
    stat = rpyc.stat()
    token = f"{rpyc}|{stat.st_mtime_ns}|{stat.st_size}"
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]
    return cache_dir / f"{rpyc.name}.{digest}.rpy"


def decompile_text(rpyc: Path, cache_dir: Path | None = None) -> str:
    """Decompile one ``.rpyc`` to ``.rpy`` text, using the on-disk cache.

    Reads only the given file; writes only into the cache dir. Raises
    RpycError when the file cannot be decompiled.
    """
    rpyc = Path(rpyc)
    resolved = rpyc.resolve()
    cache = Path(cache_dir) if cache_dir is not None else _default_cache_dir()
    cache_file = _cache_file(resolved, cache)
    if cache_file.is_file():
        return cache_file.read_text(encoding="utf-8")

    unrpyc, decompiler = ensure_loaded()
    context = unrpyc.Context()
    try:
        ast = unrpyc.get_ast(resolved, False, context)
    except Exception as exc:
        raise RpycError(f"unrpyc could not read {rpyc}: {exc}") from exc
    buffer = io.StringIO()
    options = decompiler.Options(log=context.log_contents)
    try:
        decompiler.pprint(buffer, ast, options)
    except Exception as exc:
        raise RpycError(f"unrpyc could not decompile {rpyc}: {exc}") from exc
    text = buffer.getvalue()
    if not text.strip():
        raise RpycError(f"unrpyc produced empty output for {rpyc}")

    cache.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(text, encoding="utf-8")
    return text
