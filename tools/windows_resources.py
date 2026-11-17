#!/usr/bin/env python3
"""`python tools/windows_resources.py` and `import windows_resources` (with
tools/ on sys.path), kept working now that the tool lives in the package
as kinetic_extract/windows_resources.py (docs/plan.md Phase 57, item 9).
Importing this file gives the package module itself.
"""

import sys
from pathlib import Path

_CONVERTER = str(Path(__file__).resolve().parents[1] / "converter")
if _CONVERTER not in sys.path:
    sys.path.insert(0, _CONVERTER)
from kinetic_extract import windows_resources as _tool  # noqa: E402

sys.modules[__name__] = _tool


def __getattr__(name: str):
    """A module loaded from this file's path reads the package module's
    names."""
    return getattr(_tool, name)
