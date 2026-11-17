#!/usr/bin/env python3
"""`python tools/upgrade_folder.py` and `import upgrade_folder` (with
tools/ on sys.path), kept working now that the tool lives in the package
as kinetic_extract/upgrade_folder.py, `kinetic upgrade` (docs/plan.md
Phase 57, item 9). Importing this file gives the package module itself.
"""

import sys
from pathlib import Path

_CONVERTER = str(Path(__file__).resolve().parents[1] / "converter")
if _CONVERTER not in sys.path:
    sys.path.insert(0, _CONVERTER)
from kinetic_extract import upgrade_folder as _tool  # noqa: E402

if __name__ == "__main__":
    sys.exit(_tool.main(sys.argv))
sys.modules[__name__] = _tool


def __getattr__(name: str):
    """A module loaded from this file's path reads the package module's
    names."""
    return getattr(_tool, name)
