"""Golden-hash media self-test (docs/plan.md Phase 25).

Committed sample inputs (``converter/tests/data/selftest/``) go through
every tool path the converter uses, by calling the converter's own
functions, so a recipe and its self-test cannot drift apart. Each case
yields a sha256; ``converter/media-tools.json`` stores the expected
(golden) values under ``selftest.golden``, shared by every platform.
A platform may hold its own golden for a case a CPU difference explains
(``selftest.platformGolden.<platform>.<case>``, only for the cases listed
in ``selftest.cpuDependent``): there that case uses its own golden, and
every other case the shared one. Case names are ``<tool>.<step>`` so a
mismatch names the tool.

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

from . import assets, media, media_tools, paths
from .media_tools import MediaToolsError

SAMPLES_DIR = paths.SELFTEST_SAMPLES_DIR
SAMPLES = ("sample.png", "sample.jpg", "sample.webp", "sample.gif",
           "sample.avif", "sample.mp4", "sample-odd.mp4", "sample.ogg",
           "sample.aiff")
CACHE_FILE = "selftest-cache.json"
POSTER_SECONDS = 0.5
# The last-frame case's range end, in seconds: past the 1 s sample's
# end, so its window (from 0.5 s) holds the sample's last five frames.
LAST_FRAME_NEAR = 1.5
FAILED = "FAILED"
# Sources whose code decides the outputs: a change re-runs the self-test.
_RECIPE_SOURCES = ("assets.py", "audio_format.py", "media.py",
                   "media_tools.py", "selftest.py")

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
    for name in ("sample.png", "sample.jpg", "sample.webp", "sample.gif",
                 "sample.avif"):
        out[f"pillow.decode-{name.split('.')[1]}"] = _decode_hash(data[name])
    out["pillow.encode-png"] = _sha(
        assets.run_image_step(assets.PNG_STEP, data["sample.png"]))
    out["pillow.encode-jpeg"] = _sha(
        assets.run_image_step(assets.jpeg_step(), data["sample.jpg"]))

    jxl = assets.jxl_candidate(data["sample.png"], "png").out
    out["imagecodecs.jxl-lossless"] = _sha(jxl) if jxl else FAILED
    webp_jxl = assets.jxl_candidate(data["sample.webp"], "webp").out
    out["imagecodecs.jxl-lossless-webp"] = (_sha(webp_jxl) if webp_jxl
                                            else FAILED)
    out["imagecodecs.jxl-decode"] = (
        _pixel_hash(Image.fromarray(media_tools.jxl_decode(jxl)))
        if jxl else FAILED)
    recompressed = media_tools.jxl_recompress_jpeg(data["sample.jpg"])
    out["imagecodecs.jxl-recompress-jpeg"] = _sha(recompressed)
    out["imagecodecs.jxl-reconstruct-jpeg"] = _sha(
        media_tools.jxl_reconstruct_jpeg(recompressed))

    video = samples_dir / "sample.mp4"
    found = assets.probe_video(video)
    probe = {"container": found.container if found else None,
             "codec": found.codec if found else None,
             "durationSeconds": media.probe_duration_seconds(video)}
    out["ffprobe.probe"] = _sha(json.dumps(probe, sort_keys=True).encode())
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        frame = tmp / "frame.png"
        ok = assets.extract_frame_png(video, frame, POSTER_SECONDS)
        out["ffmpeg.poster-frame"] = _file_hash(frame) if ok else FAILED
        last = tmp / "last.png"
        error = assets.ffmpeg_error(
            assets.last_frame_step(None, LAST_FRAME_NEAR)["args"], video,
            last)
        out["ffmpeg.last-frame"] = (_file_hash(last) if error is None
                                    else FAILED)
        poster = tmp / "poster.jpg"
        ok = ok and assets.poster_jpeg(frame, poster)
        out["pillow.poster-jpeg"] = _file_hash(poster) if ok else FAILED
        mp4 = tmp / "transcoded.mp4"
        ok = assets.transcode_video(video, mp4)
        out["ffmpeg.transcode-mp4"] = _file_hash(mp4) if ok else FAILED
        odd = samples_dir / "sample-odd.mp4"
        padded = tmp / "transcoded-odd.mp4"
        ok = assets.transcode_video(odd, padded, assets.probe_video(odd))
        out["ffmpeg.transcode-odd-mp4"] = (_file_hash(padded) if ok
                                           else FAILED)
        out.update(_audio_cases(samples_dir, tmp))
    return dict(sorted(out.items()))


# Audio cases: name -> the sample whose ``audio_step`` they run.
_AUDIO_CASES = {"ffmpeg.audio-remux-webm": "sample.ogg",
                "ffmpeg.audio-transcode-opus": "sample.aiff",
                "ffmpeg.audio-extract-m4a": "sample.mp4"}


# The AAC re-encode a looping track gets when it would ship as MP3 or
# Opus (``audio_step`` with ``loops``), run on the AIFF: the recipe is
# the same whatever the source codec.
LOOP_CASE = "ffmpeg.audio-loop-aac"


def _audio_file(case: str, source: Path, tmp: Path,
                loops: bool = False) -> Path | None:
    """`source` through its ``audio_step``, into `tmp`; None on failure."""
    probe = assets.probe_audio(source)
    step = assets.audio_step(probe, loops) if probe else None
    made = tmp / f"{case}.{assets.file_step_ext(step or {})}"
    ok = step is not None \
        and assets.run_file_step(step, source, made) is None
    return made if ok else None


def _audio_cases(samples_dir: Path, tmp: Path) -> dict[str, str]:
    """The converter's audio recipes on the samples: the Ogg remux into
    WebM, the AIFF re-encode to Opus, the extract of the video's AAC,
    then the decoded duration of each output and the video sound's
    volumedetect maximum; and the looping AIFF's re-encode to AAC."""
    out: dict[str, str] = {}
    durations: dict[str, float | None] = {}
    for case, name in _AUDIO_CASES.items():
        made = _audio_file(case, samples_dir / name, tmp)
        out[case] = _file_hash(made) if made else FAILED
        durations[case] = assets.decoded_duration(made) if made else None
    out["ffmpeg.audio-duration"] = _sha(
        json.dumps(durations, sort_keys=True).encode())
    loudness = assets.max_volume(samples_dir / "sample.mp4")
    out["ffmpeg.audio-loudness"] = _sha(json.dumps(loudness).encode())
    looped = _audio_file(LOOP_CASE, samples_dir / "sample.aiff", tmp,
                         loops=True)
    out[LOOP_CASE] = _file_hash(looped) if looped else FAILED
    return out


def cpu_dependent(pins: dict[str, Any]) -> list[str]:
    """The cases a CPU difference explains (``selftest.cpuDependent``):
    the only ones a platform may hold its own golden for."""
    return list(pins["selftest"].get("cpuDependent") or [])


def check_platform_goldens(pins: dict[str, Any]) -> None:
    """Refuse (MediaToolsError) a ``selftest.platformGolden`` entry for a
    platform the pin file does not list, or for a case that has no shared
    golden or is not in ``selftest.cpuDependent``."""
    shared = pins["selftest"].get("golden") or {}
    allowed = cpu_dependent(pins)
    unknown = [case for case in allowed if case not in shared]
    if shared and unknown:
        raise MediaToolsError(
            "selftest.cpuDependent in converter/media-tools.json names "
            f"unknown case(s): {', '.join(unknown)}")
    table = pins["selftest"].get("platformGolden") or {}
    if not isinstance(table, dict):
        raise MediaToolsError("selftest.platformGolden in "
                              "converter/media-tools.json is not a table")
    for plat, own in sorted(table.items()):
        where = f"selftest.platformGolden.{plat}"
        if plat not in pins["ffmpeg"]["platforms"]:
            raise MediaToolsError(
                f"{where} in converter/media-tools.json: no such platform "
                f"(platforms: {', '.join(pins['ffmpeg']['platforms'])})")
        if not isinstance(own, dict):
            raise MediaToolsError(f"{where} in converter/media-tools.json "
                                  "is not a table")
        for case, value in sorted(own.items()):
            if case not in shared:
                raise MediaToolsError(
                    f"{where}.{case} in converter/media-tools.json: no "
                    "such self-test case")
            if case not in allowed:
                raise MediaToolsError(
                    f"{where}.{case} in converter/media-tools.json: not a "
                    "CPU-dependent case (selftest.cpuDependent)")
            if not isinstance(value, str) or not value:
                raise MediaToolsError(f"{where}.{case} in "
                                      "converter/media-tools.json is empty")


def platform_golden(pins: dict[str, Any], plat: str) -> dict[str, str]:
    """`plat`'s own goldens (checked first: check_platform_goldens)."""
    check_platform_goldens(pins)
    table = pins["selftest"].get("platformGolden") or {}
    return dict(table.get(plat) or {})


def golden_for(pins: dict[str, Any], plat: str) -> dict[str, str | None]:
    """The goldens `plat` is checked against: the shared ones, with the
    platform's own in place for its CPU-dependent cases."""
    return {**(pins["selftest"].get("golden") or {}),
            **platform_golden(pins, plat)}


def unpinned_cases(golden: dict[str, str | None]) -> list[str]:
    """Cases listed with a null golden: a new case waiting for --pin, or
    one --repin cleared."""
    return sorted(case for case, value in golden.items() if value is None)


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
              binaries: dict[str, str], samples_dir: Path,
              plat: str) -> str:
    """What a cached pass depends on: change any of it and the test re-runs.
    The goldens are the ones `plat` is checked against."""
    material = {
        "ffmpeg": pins["ffmpeg"]["version"],
        "binaries": binaries,
        "python": versions,
        "samples": {name: _file_hash(samples_dir / name)
                    for name in SAMPLES},
        "recipe": {name: _file_hash(Path(__file__).parent / name)
                   for name in _RECIPE_SOURCES},
        "golden": golden_for(pins, plat),
    }
    return _sha(json.dumps(material, sort_keys=True).encode())


def read_cache(plat_dir: Path) -> str | None:
    try:
        return json.loads((plat_dir / CACHE_FILE).read_text("utf-8"))["key"]
    except (OSError, ValueError, KeyError, TypeError):
        return None


def write_cache(plat_dir: Path, key: str) -> None:
    (plat_dir / CACHE_FILE).write_text(json.dumps({"key": key}) + "\n",
                                       "utf-8", newline="\n")


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
    against the pins, goldens pinned, then the self-test against this
    platform's goldens (golden_for), or its cached pass for exactly these
    inputs.
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
    golden = golden_for(pins, plat)
    if not golden:
        raise MediaToolsError(
            "media self-test not pinned yet (selftest.golden is null in "
            f"converter/media-tools.json): run {media_tools.SETUP_CMD} --pin")
    unpinned = unpinned_cases(golden)
    if unpinned:
        raise MediaToolsError(
            f"media self-test case(s) {', '.join(unpinned)} not pinned yet "
            "(null in converter/media-tools.json): run "
            f"{media_tools.SETUP_CMD} --pin")
    key = cache_key(pins, versions, binaries, samples_dir, plat)
    if read_cache(plat_dir) == key:
        return
    lines = compare(golden, runner(samples_dir))
    if lines:
        raise mismatch_error(lines)
    write_cache(plat_dir, key)
