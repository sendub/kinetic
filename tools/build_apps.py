#!/usr/bin/env python3
"""`python tools/build_apps.py` and `import build_apps` (with tools/ on
sys.path), kept working now that the tool is `kinetic apps`,
kinetic_extract/apps.py (docs/plan.md Phase 57, items 9 and 10): the same
flags, outputs and exit codes. Importing this file gives the package
module itself.
"""

import sys
from pathlib import Path

_CONVERTER = str(Path(__file__).resolve().parents[1] / "converter")
if _CONVERTER not in sys.path:
    sys.path.insert(0, _CONVERTER)
from kinetic_extract import apps as _tool  # noqa: E402

if __name__ == "__main__":
    sys.exit(_tool.main(sys.argv[1:], prog="build_apps.py"))
sys.modules[__name__] = _tool


def __getattr__(name: str):
    """A module loaded from this file's path reads the package module's
    names."""
    return getattr(_tool, name)
