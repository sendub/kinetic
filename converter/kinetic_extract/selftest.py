"""Golden-hash media self-test (docs/plan.md Phase 25).

Committed sample inputs (``converter/tests/data/selftest/``) go through
every tool path the converter uses, by calling the converter's own
functions, so a recipe and its self-test cannot drift apart. Each case
yields a sha256; ``converter/media-tools.json`` stores the expected
(golden) values under ``selftest.golden``. Case names are
``<tool>.<step>`` so a mismatch names the tool.

The setup script runs it after installing (and with ``--pin`` records
the goldens); ``kinetic-extract`` runs it at start through
:func:`ensure_ready`, which refuses on anything missing, unpinned or
mismatched. A pass is cached in ``.media-tools/<platform>/`` under a key
built from the tool versions, the binaries', samples' and recipe sources'
hashes and the goldens, so a normal start only re-hashes files.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

from . import assets, media, media_tools
from .media_tools import MediaToolsError

SAMPLES_DIR = media_tools.CONVERTER_DIR / "tests" / "data" / "selftest"
SAMPLES = ("sample.png", "sample.jpg", "sample.webp", "sample.gif",
           "sample.mp4")
CACHE_FILE = "selftest-cache.json"
POSTER_SECONDS = 0.5
FAILED = "FAILED"
# Sources whose code decides the outputs: a change re-runs the self-test.
_RECIPE_SOURCES = ("assets.py", "media.py", "media_tools.py", "selftest.py")

Runner = Callable[[Path], dict[str, str]]


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pixel_hash(img: Any) -> str:
    head = f"{img.mode} {img.size[0]}x{img.size[1]}\n".encode()
    return _sha(head + img.tobytes())


def _decode_hash(data: bytes) -> str:
    """Hash of every frame's decoded pixels."""
    from PIL import Image, ImageSequence

    with Image.open(BytesIO(data)) as img:
        frames = [_pixel_hash(frame.copy())
                  for frame in ImageSequence.Iterator(img)]
    return _sha("\n".join(frames).encode())


def _file_hash(path: Path) -> str:
    return _sha(path.read_bytes()) if path.is_file() else FAILED


def run_cases(samples_dir: Path = SAMPLES_DIR) -> dict[str, str]:
    """case -> sha256 (or FAILED) for every converter tool path."""
    from PIL import Image

    data = {name: (samples_dir / name).read_bytes() for name in SAMPLES}
    out: dict[str, str] = {}
    for name in ("sample.png", "sample.jpg", "sample.webp", "sample.gif"):
        out[f"pillow.decode-{name.split('.')[1]}"] = _decode_hash(data[name])
    with Image.open(BytesIO(data["sample.png"])) as img:
        img.load()
        out["pillow.encode-png"] = _sha(assets._encode_png(img))
    with Image.open(BytesIO(data["sample.jpg"])) as img:
        img.load()
        out["pillow.encode-jpeg"] = _sha(assets._encode_jpeg(img))

    jxl = assets._encode_jxl_lossless(data["sample.png"], "png")
    out["imagecodecs.jxl-lossless"] = _sha(jxl) if jxl else FAILED
    out["imagecodecs.jxl-decode"] = (
        _pixel_hash(Image.fromarray(media_tools.jxl_decode(jxl)))
        if jxl else FAILED)
    recompressed = media_tools.jxl_recompress_jpeg(data["sample.jpg"])
    out["imagecodecs.jxl-recompress-jpeg"] = _sha(recompressed)
    out["imagecodecs.jxl-reconstruct-jpeg"] = _sha(
        media_tools.jxl_reconstruct_jpeg(recompressed))

    video = samples_dir / "sample.mp4"
    container, codec = assets.probe_video(video)
    probe = {"container": container, "codec": codec,
             "durationSeconds": media.probe_duration_seconds(video)}
    out["ffprobe.probe"] = _sha(json.dumps(probe, sort_keys=True).encode())
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        frame = tmp / "frame.png"
        ok = assets.extract_frame_png(video, frame, POSTER_SECONDS)
        out["ffmpeg.poster-frame"] = _file_hash(frame) if ok else FAILED
        poster = tmp / "poster.jpg"
        ok = ok and assets.poster_jpeg(frame, poster)
        out["pillow.poster-jpeg"] = _file_hash(poster) if ok else FAILED
        mp4 = tmp / "transcoded.mp4"
        ok = assets.transcode_video(video, mp4)
        out["ffmpeg.transcode-mp4"] = _file_hash(mp4) if ok else FAILED
    return dict(sorted(out.items()))


def compare(golden: dict[str, str], actual: dict[str, str]) -> list[str]:
    """One line per mismatched case, naming its tool."""
    lines = []
    for case in sorted(set(golden) | set(actual)):
        want, got = golden.get(case), actual.get(case)
        if want != got:
            tool = case.split(".", 1)[0]
            lines.append(f"{tool} ({case}): expected {want}, got {got}")
    return lines


def cache_key(pins: dict[str, Any], versions: dict[str, str],
              binaries: dict[str, str], samples_dir: Path) -> str:
    """What a cached pass depends on: change any of it and the test re-runs."""
    material = {
        "ffmpeg": pins["ffmpeg"]["version"],
        "binaries": binaries,
        "python": versions,
        "samples": {name: _file_hash(samples_dir / name)
                    for name in SAMPLES},
        "recipe": {name: _file_hash(Path(__file__).parent / name)
                   for name in _RECIPE_SOURCES},
        "golden": pins["selftest"]["golden"],
    }
    return _sha(json.dumps(material, sort_keys=True).encode())


def read_cache(plat_dir: Path) -> str | None:
    try:
        return json.loads((plat_dir / CACHE_FILE).read_text("utf-8"))["key"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_cache(plat_dir: Path, key: str) -> None:
    (plat_dir / CACHE_FILE).write_text(json.dumps({"key": key}) + "\n",
                                       "utf-8")


def mismatch_error(lines: list[str]) -> MediaToolsError:
    return MediaToolsError(
        "media self-test mismatch: the tools would not reproduce the pinned "
        "output, refusing to convert:\n  " + "\n  ".join(lines))


def ensure_ready(*, pins: dict[str, Any] | None = None,
                 versions: dict[str, str] | None = None,
                 plat: str | None = None, root: Path | None = None,
                 samples_dir: Path = SAMPLES_DIR,
                 runner: Runner = run_cases) -> None:
    """Refuse (MediaToolsError) unless the pinned tools pass the self-test.

    Checks, in order: Python codec versions, the installed ffmpeg/ffprobe
    against the pins, goldens pinned, then the self-test (or its cached
    pass for exactly these inputs).
    """
    if media_tools.override_dir() is not None:
        media_tools.warn_test_override()
        return
    pins = pins if pins is not None else media_tools.load_pins()
    versions = versions if versions is not None \
        else media_tools.python_versions()
    media_tools.check_python_pins(pins, versions)
    plat = plat or media_tools.platform_key()
    plat_dir = (root or media_tools.TOOLS_ROOT) / plat
    binaries = media_tools.check_installed(pins, plat_dir, plat)
    golden = pins["selftest"]["golden"]
    if not golden:
        raise MediaToolsError(
            "media self-test not pinned yet (selftest.golden is null in "
            f"converter/media-tools.json): run {media_tools.SETUP_CMD} --pin")
    key = cache_key(pins, versions, binaries, samples_dir)
    if read_cache(plat_dir) == key:
        return
    lines = compare(golden, runner(samples_dir))
    if lines:
        raise mismatch_error(lines)
    write_cache(plat_dir, key)
