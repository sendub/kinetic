"""Test-wide media tool setup (docs/plan.md Phase 25).

The converter runs only the pinned ffmpeg/ffprobe from ``.media-tools/``
and refuses to start until they pass the golden-hash self-test. The suite
must also run on a checkout that has not installed them, so it points the
TEST-ONLY ``KINETIC_MEDIA_TOOLS_DIR`` override at a directory linking the
system ffmpeg/ffprobe. With the override set, kinetic-extract skips the
pin and self-test checks and warns; tests of those checks unset it.
Never set this variable for a real conversion: its output is not
reproducible.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest

from kinetic_extract.media_tools import TEST_DIR_ENV, TOOL_NAMES


@pytest.fixture(scope="session", autouse=True)
def system_media_tools(tmp_path_factory: pytest.TempPathFactory,
                       ) -> Iterator[Path]:
    """KINETIC_MEDIA_TOOLS_DIR -> a dir of links to the system ffmpeg."""
    tool_dir = tmp_path_factory.mktemp("media-tools")
    for name in TOOL_NAMES:
        found = shutil.which(name)
        if found:
            (tool_dir / name).symlink_to(found)
    previous = os.environ.get(TEST_DIR_ENV)
    os.environ[TEST_DIR_ENV] = str(tool_dir)
    yield tool_dir
    if previous is None:
        os.environ.pop(TEST_DIR_ENV, None)
    else:
        os.environ[TEST_DIR_ENV] = previous
