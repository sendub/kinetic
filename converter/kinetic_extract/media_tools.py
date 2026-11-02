"""Pinned media tools (docs/plan.md Phase 25).

The converter encodes and decodes media ONLY with pinned tools, so the same
game gives the same bytes on any machine:

- Pillow, imagecodecs (bundling libjxl) and numpy at the versions pinned in
  ``converter/media-tools.json`` (and requirements.txt);
- ffmpeg and ffprobe from the pinned static build that
  ``tools/setup_media_tools.py`` installs into ``.media-tools/<platform>/``
  at the repo root. PATH is never searched.

Every encoder runs single-threaded with bitexact settings (the argument
lists below). ``KINETIC_MEDIA_TOOLS_DIR`` is a TEST-ONLY override that
points the ffmpeg/ffprobe lookup at another directory and skips the pin
and self-test checks; it is not for real conversions (their output is not
reproducible).
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

CONVERTER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = CONVERTER_DIR.parent
PIN_FILE = CONVERTER_DIR / "media-tools.json"
TOOLS_ROOT = REPO_ROOT / ".media-tools"
INSTALLED_FILE = "installed.json"
TEST_DIR_ENV = "KINETIC_MEDIA_TOOLS_DIR"
SETUP_CMD = ".venv/bin/python tools/setup_media_tools.py"
TOOL_NAMES = ("ffmpeg", "ffprobe")
PLATFORMS = ("macos-arm64", "macos-x86_64", "linux-x86_64", "linux-arm64")

# ffmpeg argument groups. GLOBAL leads every command, DECODE goes before
# each -i (decoder threads), ENCODE goes before every written output.
FFMPEG_GLOBAL = ["-nostdin", "-hide_banner", "-v", "error",
                 "-filter_threads", "1"]
FFMPEG_DECODE = ["-threads", "1"]
FFMPEG_ENCODE = ["-threads", "1", "-fflags", "+bitexact",
                 "-flags:v", "+bitexact", "-flags:a", "+bitexact",
                 "-map_metadata", "-1"]

# Lossless JPEG XL: libjxl effort 9, one thread.
JXL_EFFORT = 9


class MediaToolsError(Exception):
    """The pinned media tools are missing, unpinned or mismatched."""


def platform_key(system: str | None = None,
                 machine: str | None = None) -> str:
    """``macos-arm64``-style key for this OS/arch (a media-tools.json key)."""
    system = (system or platform.system()).lower()
    machine = (machine or platform.machine()).lower()
    os_name = {"darwin": "macos", "linux": "linux"}.get(system)
    arch = {"arm64": "arm64", "aarch64": "arm64",
            "x86_64": "x86_64", "amd64": "x86_64"}.get(machine)
    if os_name is None or arch is None:
        raise MediaToolsError(
            f"no pinned media tools for {system}/{machine}; supported: "
            + ", ".join(PLATFORMS))
    return f"{os_name}-{arch}"


def load_pins(path: Path = PIN_FILE) -> dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MediaToolsError(f"cannot read {path}: {exc}") from exc


def override_dir() -> Path | None:
    """The TEST-ONLY tools directory, when the test suite set one."""
    value = os.environ.get(TEST_DIR_ENV)
    return Path(value) if value else None


def tools_dir() -> Path:
    """Where ffmpeg/ffprobe live: ``.media-tools/<platform>/``."""
    return override_dir() or TOOLS_ROOT / platform_key()


def tool_path(name: str) -> Path:
    """The pinned binary `name`; never looked up on PATH."""
    path = tools_dir() / name
    if not (path.is_file() and os.access(path, os.X_OK)):
        raise MediaToolsError(
            f"{name} not found in {path.parent} (the converter uses only "
            f"the pinned build): run {SETUP_CMD}")
    return path


def ffmpeg_cmd() -> list[str]:
    return [str(tool_path("ffmpeg")), *FFMPEG_GLOBAL]


def ffprobe_cmd() -> list[str]:
    return [str(tool_path("ffprobe")), "-v", "error", "-threads", "1"]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# --- Python codec pins -------------------------------------------------------

def python_versions() -> dict[str, str]:
    """Installed versions of the pinned Python codec stack."""
    import imagecodecs
    import numpy
    import PIL

    libjxl = imagecodecs.jpegxl_version().split()[-1]
    return {"Pillow": PIL.__version__, "imagecodecs": imagecodecs.__version__,
            "numpy": numpy.__version__, "libjxl": libjxl}


def check_python_pins(pins: dict[str, Any],
                      installed: dict[str, str] | None = None) -> None:
    installed = installed if installed is not None else python_versions()
    bad = [f"{name} {installed.get(name)} (pinned {want})"
           for name, want in pins["python"].items()
           if installed.get(name) != want]
    if bad:
        raise MediaToolsError(
            "installed codec versions differ from converter/media-tools.json: "
            + "; ".join(bad)
            + ": run .venv/bin/pip install -r requirements.txt "
              "--cache .tmp/pip-cache")


def binary_version(name: str) -> str | None:
    """The version token ``<name> -version`` reports (``9.0.2``), or None."""
    import subprocess

    try:
        proc = subprocess.run([str(tool_path(name)), "-version"],
                              capture_output=True, text=True, check=False)
    except (OSError, MediaToolsError):
        return None
    words = proc.stdout.split()
    if proc.returncode != 0 or len(words) < 3 or words[1] != "version":
        return None
    return words[2]


def run_tools(extractor_version: str) -> dict[str, Any]:
    """The tools this run converts with, for the ledger's ``mediaTools``:
    ffmpeg/ffprobe version and binary sha256, the Python codec stack, the
    extractor version, and whether the pinned install is in use (False
    under the test-only override)."""
    out: dict[str, Any] = {"kinetic-extract": extractor_version,
                           "pinned": override_dir() is None}
    for name in TOOL_NAMES:
        try:
            binary = tool_path(name)
        except MediaToolsError:
            out[name] = None
            continue
        out[name] = {"version": binary_version(name),
                     "sha256": sha256_file(binary)}
    out.update(python_versions())
    return out


# --- installed ffmpeg/ffprobe ------------------------------------------------

def check_installed(pins: dict[str, Any], plat_dir: Path,
                    plat: str) -> dict[str, str]:
    """Binary sha256 per tool, after checking the install matches the pins.

    ``installed.json`` (written by the setup script) must name the pinned
    version and archive checksums, and each binary must still hash to what
    setup recorded.
    """
    ff = pins["ffmpeg"]
    entries = ff["platforms"].get(plat)
    if entries is None:
        raise MediaToolsError(f"converter/media-tools.json has no {plat} "
                              "entry")
    unpinned = [name for name in TOOL_NAMES if not entries[name]["sha256"]]
    if unpinned:
        raise MediaToolsError(
            f"{', '.join(unpinned)} for {plat} not pinned yet (sha256 null in "
            f"converter/media-tools.json): run {SETUP_CMD} --pin")
    try:
        installed = json.loads((plat_dir / INSTALLED_FILE).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        raise MediaToolsError(f"no media tools installed in {plat_dir}: run "
                              f"{SETUP_CMD}") from None
    if installed.get("version") != ff["version"]:
        raise MediaToolsError(
            f"installed ffmpeg {installed.get('version')} != pinned "
            f"{ff['version']}: run {SETUP_CMD}")
    hashes: dict[str, str] = {}
    for name in TOOL_NAMES:
        record = installed.get("tools", {}).get(name, {})
        if record.get("archiveSha256") != entries[name]["sha256"] \
                or record.get("url") != entries[name]["url"]:
            raise MediaToolsError(
                f"installed {name} is not the pinned archive: run "
                f"{SETUP_CMD}")
        binary = plat_dir / name
        actual = sha256_file(binary) if binary.is_file() else None
        if actual != record.get("binarySha256"):
            raise MediaToolsError(
                f"{binary} changed since setup (sha256 {actual}, recorded "
                f"{record.get('binarySha256')}): run {SETUP_CMD}")
        hashes[name] = actual
    return hashes


# --- JPEG XL through imagecodecs (libjxl) ------------------------------------

def jxl_available() -> bool:
    import imagecodecs

    return bool(imagecodecs.JPEGXL.available)


def jxl_encode_lossless(pixels: Any, effort: int = JXL_EFFORT) -> bytes:
    """Mathematically lossless JXL of an (H, W[, C]) uint8 array (the
    ledger records `effort`; the converter always uses JXL_EFFORT)."""
    import imagecodecs

    return bytes(imagecodecs.jpegxl_encode(pixels, lossless=True,
                                           effort=effort, numthreads=1))


def jxl_decode(data: bytes) -> Any:
    import imagecodecs

    return imagecodecs.jpegxl_decode(data, numthreads=1)


def jxl_recompress_jpeg(data: bytes) -> bytes:
    """JPEG XL lossless recompression of JPEG bytes (reconstructible)."""
    import imagecodecs

    return bytes(imagecodecs.jpegxl_encode_jpeg(data, numthreads=1))


def jxl_reconstruct_jpeg(data: bytes) -> bytes:
    """The original JPEG bytes back from a recompressed JXL."""
    import imagecodecs

    return bytes(imagecodecs.jpegxl_decode_jpeg(data, numthreads=1))


def warn_test_override() -> None:
    print(f"kinetic-extract: WARNING {TEST_DIR_ENV} is set (test-only): "
          "using unpinned media tools, no self-test; output is not "
          "reproducible", file=sys.stderr)
