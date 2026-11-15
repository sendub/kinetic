"""Start the helper: ``python -m kinetic_voice --root DIR`` with this
package's parent on sys.path, or ``python .../kinetic_voice/__main__.py
--root DIR``."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kinetic_voice.engine import create_engine  # noqa: E402
from kinetic_voice.install import (  # noqa: E402
    Installer,
    Lock,
    default_lock_path,
)
from kinetic_voice.server import Server  # noqa: E402


def private_environment(root: Path) -> None:
    """Keep every library's files inside the voice folder, and the
    Hugging Face hub offline: the helper downloads the model itself."""
    hf = root / "cache" / "hf"
    os.environ.update({
        "HF_HOME": str(hf),
        "HF_HUB_CACHE": str(root / "models"),
        "HF_XET_CACHE": str(hf / "xet"),
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "HF_HUB_DISABLE_PROGRESS_BARS": "1",
        "TOKENIZERS_PARALLELISM": "false",
        "XDG_CACHE_HOME": str(root / "cache" / "xdg"),
        "TORCH_HOME": str(root / "cache" / "torch"),
        "NUMBA_CACHE_DIR": str(root / "cache" / "numba"),
        "MPLCONFIGDIR": str(root / "cache" / "mpl"),
        "PYTHONNOUSERSITE": "1",
    })


def protocol_stream():
    """The real stdout, for protocol lines only. File descriptor 1 then
    points at stderr, so prints from libraries, Python's or C's, cannot
    break the protocol."""
    out = os.fdopen(os.dup(1), "wb")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return out


def main() -> None:
    parser = argparse.ArgumentParser(prog="kinetic_voice")
    parser.add_argument("--root", required=True, type=Path,
                        help="the voice folder")
    parser.add_argument("--lock", type=Path, default=None,
                        help="lock file (default: lock-<platform>.json "
                             "beside the package)")
    parser.add_argument("--engine", default=None,
                        help="engine name (default: the lock's; 'fake' "
                             "for tests)")
    parser.add_argument("--fake-delay", type=float, default=0.0,
                        help="seconds the fake engine takes per line")
    args = parser.parse_args()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    private_environment(root)
    out = protocol_stream()
    trace = os.environ.get("KINETIC_VOICE_TRACE")  # a debugging aid
    if trace:
        import faulthandler
        faulthandler.dump_traceback_later(float(trace), repeat=True)
    lock = Lock.read(args.lock or default_lock_path())
    engine = create_engine(args.engine or lock.engine["id"], root, lock.data,
                           args.fake_delay)
    server = Server(root, Installer(root, lock, lambda msg: None), engine,
                    out)
    server.serve(sys.stdin.buffer)
    out.flush()
    sys.stderr.flush()
    # The engine thread may be inside native code: leave without waiting.
    os._exit(0)


if __name__ == "__main__":
    main()
