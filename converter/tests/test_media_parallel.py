"""Parallel workers for ``kinetic-media ship`` and ``rebuild``
(``--jobs``, ``--video-jobs``; docs/extracting.md, "Parallel workers").

Encodes run ahead on worker threads, each distinct one once; one
coordinator places outputs and writes the ledger in request order, so
the folder is byte-identical to a ``--jobs 1`` run. Outputs and the
ledger appear whole or not at all.
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import threading
import time
from pathlib import Path

import numpy
import pytest

from kinetic_extract import assets, media_cli
from kinetic_extract import rpa as rpa_mod
from kinetic_extract.media import jxl_codestream_size, write_whole
from kinetic_extract.media_cli import main as media_main
from kinetic_extract import media_tools
from kinetic_extract.workers import Progress, Workers
from test_rpa import tiny_png_bytes

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
CLIP = REPO_ROOT / "fixtures" / "renpy_demo" / "game" / "data" / "clip.mp4"
LEDGER = "media-ledger.json"


@pytest.fixture(autouse=True)
def _caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rpa_mod.reset_cache()
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    monkeypatch.setenv("KINETIC_DECOMPILE_CACHE", str(tmp_path / "decomp"))
    # Every run cold: equal folders then prove equal encodes, not hits.
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")


def _encode(out: Path, *args: str) -> None:
    cmd = [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
           "-i", "testsrc=size=64x36:rate=10:duration=1", *args, "-an",
           str(out)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr


@pytest.fixture(scope="module")
def game(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """Videos for every rule (copy, remux, transcode), images, and the
    same video bytes under two names."""
    root = tmp_path_factory.mktemp("parallel-game")
    (root / "v").mkdir()
    (root / "i").mkdir()
    shutil.copyfile(CLIP, root / "v" / "clip.mp4")
    shutil.copyfile(CLIP, root / "v" / "clip-copy.mp4")
    _encode(root / "v" / "remux.mkv", "-c:v", "libx264", "-pix_fmt",
            "yuv420p")
    _encode(root / "v" / "mpeg4.avi", "-c:v", "mpeg4")
    _encode(root / "v" / "mpeg4b.avi", "-c:v", "mpeg4", "-q:v", "9")
    (root / "i" / "a.png").write_bytes(tiny_png_bytes((10, 120, 200)))
    (root / "i" / "b.png").write_bytes(tiny_png_bytes((200, 20, 10)))
    (root / "i" / "a-again.png").write_bytes(tiny_png_bytes((10, 120, 200)))
    return root


def _video(path: str, **extra) -> dict:
    return {"source": {"path": path}, "kind": "video", **extra}


def _image(path: str, **extra) -> dict:
    return {"source": {"path": path}, "kind": "image", **extra}


REQUESTS = [
    _video("v/mpeg4.avi"),                       # slowest first
    _video("v/clip.mp4"),
    _image("i/a.png", id="a"),
    _video("v/clip.mp4", startSeconds=0.5),
    _video("v/remux.mkv", startSeconds=0.3),
    _video("v/clip-copy.mp4"),                   # same bytes as clip.mp4
    _video("v/clip.mp4", id="same-frame"),       # same poster again
    _image("i/b.png"),
    _video("v/mpeg4b.avi", startSeconds=0.5),
    _image("i/a-again.png"),                     # same bytes as a.png
    _video("v/missing.mp4"),
    _video("v/mpeg4.avi", startSeconds=0.2, id="t2"),
]


def ship(root: Path, out: Path, requests: list[dict], *extra: str) -> int:
    listing = out.parent / f"{out.name}-list.json"
    listing.parent.mkdir(parents=True, exist_ok=True)
    listing.write_text(json.dumps(requests), encoding="utf-8")
    return media_main(["ship", str(root), str(out), "--list", str(listing),
                       *extra])


def tree(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes()
            for p in sorted(folder.rglob("*")) if p.is_file()}


def check_whole(folder: Path) -> None:
    """Only content-addressed files with their own bytes, no leftovers."""
    import hashlib

    for path in folder.rglob("*"):
        assert not path.name.startswith(".kinetic-tmp-"), path
        if path.is_file() and path.parent.parent.name == "media":
            assert hashlib.sha256(path.read_bytes()).hexdigest() == \
                path.stem, path


# --- parallel output identical to serial -----------------------------------

@pytest.mark.parametrize("extra", [("--jobs", "4", "--video-jobs", "2"),
                                   ("--jobs", "3", "--video-jobs", "1"),
                                   ()])
def test_parallel_folder_identical_to_serial(
        game: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str],
        extra: tuple[str, ...]) -> None:
    serial = tmp_path / "serial"
    assert ship(game, serial, REQUESTS, "--jobs", "1") == 0
    serial_out = capsys.readouterr().out
    parallel = tmp_path / "parallel"
    assert ship(game, parallel, REQUESTS, *extra) == 0
    assert capsys.readouterr().out == serial_out
    assert tree(parallel) == tree(serial)
    ledger = json.loads((parallel / LEDGER).read_text("utf-8"))
    # Request order, every rule exercised, shared outputs shared.
    assert [e["request"] for e in ledger["requests"]] == REQUESTS
    results = [e["result"] for e in ledger["requests"]]
    decisions = [r["decision"] for r in results]
    assert decisions[:2] == ["transcode", "copy"]
    assert "remux" in decisions and "missing-source" in decisions
    assert results[1]["poster"] == results[5]["poster"] == \
        results[6]["poster"]
    assert results[1]["poster"] != results[3]["poster"]
    assert results[2]["file"] == results[9]["file"]
    assert results[0]["file"] == results[11]["file"]
    check_whole(parallel)


def test_rebuild_parallel_matches_serial(
        game: Path, tmp_path: Path,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out"
    assert ship(game, out, REQUESTS, "--jobs", "4") == 0
    capsys.readouterr()
    assert media_main(["rebuild", str(game), str(out), "--jobs", "1"]) == 0
    serial = capsys.readouterr().out
    redo = tmp_path / "redo"
    assert media_main(["rebuild", str(game), str(out), "--jobs", "4",
                       "--video-jobs", "2", "--out", str(redo)]) == 0
    assert capsys.readouterr().out.replace(
        f": media written to {redo}", "") == serial
    assert tree(redo / "media") == tree(out / "media")
    # A wrong file is reported in the same place either way.
    victim = next(p for p in sorted((out / "media").rglob("*.mp4")))
    victim.write_bytes(b"not it")
    assert media_main(["rebuild", str(game), str(out), "--jobs", "1"]) == 1
    serial = capsys.readouterr().out
    assert media_main(["rebuild", str(game), str(out), "--jobs", "4"]) == 1
    assert capsys.readouterr().out == serial
    assert "folder file differs" in serial


# --- dedupe ------------------------------------------------------------------

class _Counter:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.lock = threading.Lock()

    def wrap(self, fn, key):
        def counted(*args, **kwargs):
            with self.lock:
                self.calls.append(key(*args))
            return fn(*args, **kwargs)
        return counted


def test_shared_work_runs_once(game: Path, tmp_path: Path,
                               monkeypatch: pytest.MonkeyPatch) -> None:
    posters, images, steps = _Counter(), _Counter(), _Counter()
    monkeypatch.setattr(assets, "extract_poster", posters.wrap(
        assets.extract_poster, lambda src, start, *a: (src.name, start)))
    monkeypatch.setattr(assets, "decide_image_ship", images.wrap(
        assets.decide_image_ship, lambda data, *a: len(data)))
    monkeypatch.setattr(assets, "run_file_step", steps.wrap(
        assets.run_file_step, lambda step, src, *a: (step["step"],
                                                     src.name)))
    assert ship(game, tmp_path / "out", REQUESTS, "--jobs", "4") == 0
    # clip.mp4@0 serves three requests (one by identical bytes);
    # mpeg4.avi is transcoded once for two requests.
    assert sorted(posters.calls) == sorted([
        ("mpeg4.avi", 0.0), ("clip.mp4", 0.0), ("clip.mp4", 0.5),
        ("remux.mkv", 0.3), ("mpeg4b.avi", 0.5), ("mpeg4.avi", 0.2)])
    videos = [c for c in steps.calls if c[0] != "poster"]
    assert sorted(videos) == [("remux", "remux.mkv"),
                              ("transcode", "mpeg4.avi"),
                              ("transcode", "mpeg4b.avi")]
    # a.png and a-again.png are the same bytes: one decision; b.png one,
    # plus one per poster frame.
    assert len(images.calls) == 2 + len(posters.calls)


# --- atomic publish -----------------------------------------------------------

def test_failing_job_leaves_no_partial_output_or_ledger(
        game: Path, tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch) -> None:
    out = tmp_path / "out"
    first = [REQUESTS[1], REQUESTS[2]]
    assert ship(game, out, first, "--jobs", "4") == 0
    before = tree(out)
    real = assets.extract_poster

    def fails_for_remux(source: Path, start: float, *args):
        if source.name == "remux.mkv":
            time.sleep(0.2)  # let other jobs finish and be placed first
            raise RuntimeError("worker died")
        return real(source, start, *args)

    monkeypatch.setattr(assets, "extract_poster", fails_for_remux)
    with pytest.raises(RuntimeError, match="worker died"):
        ship(game, out, REQUESTS, "--jobs", "4", "--video-jobs", "2")
    after = tree(out)
    # The old ledger stands untouched; anything new is whole.
    assert after[LEDGER] == before[LEDGER]
    for name, data in before.items():
        assert after[name] == data
    check_whole(out)


def test_write_whole_keeps_old_file_on_failure(tmp_path: Path) -> None:
    target = tmp_path / "ledger.json"
    target.write_text("old", encoding="utf-8")

    def half(tmp: Path) -> None:
        tmp.write_text("ne", encoding="utf-8")
        raise OSError("disk full")

    with pytest.raises(OSError):
        write_whole(target, half)
    assert target.read_text("utf-8") == "old"
    assert [p.name for p in tmp_path.iterdir()] == ["ledger.json"]
    write_whole(target, lambda tmp: tmp.write_text("new", encoding="utf-8"))
    assert target.read_text("utf-8") == "new"


def test_publish_failure_leaves_no_output(game: Path, tmp_path: Path,
                                          monkeypatch: pytest.MonkeyPatch,
                                          ) -> None:
    out = tmp_path / "out"

    def half_copy(src, dst, *a, **k):
        Path(dst).write_bytes(Path(src).read_bytes()[:10])
        raise OSError("disk full")

    monkeypatch.setattr(assets.shutil, "copyfile", half_copy)
    with pytest.raises(OSError, match="disk full"):
        ship(game, out, [REQUESTS[1]], "--jobs", "1")
    assert not list((out / "media").rglob("*.mp4"))
    check_whole(out)
    assert not (out / LEDGER).exists()


# --- progress ----------------------------------------------------------------

def test_progress_counts_requests(game: Path, tmp_path: Path,
                                  monkeypatch: pytest.MonkeyPatch,
                                  capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(media_cli, "PROGRESS_SECONDS", 0.0)
    assert ship(game, tmp_path / "out", REQUESTS, "--jobs", "4") == 0
    lines = [ln for ln in capsys.readouterr().err.splitlines()
             if ln.startswith("progress: ")]
    total = len(REQUESTS)  # requests, not the fewer distinct outputs
    assert [ln.split()[1] for ln in lines] == \
        [f"{n}/{total}" for n in range(1, total + 1)]
    assert lines[-1].startswith(f"progress: {total}/{total} (100.0%), ")


def test_progress_is_throttled() -> None:
    stream = io.StringIO()
    progress = Progress("progress", 1000, stream, interval=3600)
    for done in range(1, 1001):
        progress(done)
    (line,) = stream.getvalue().splitlines()
    assert line.startswith("progress: 1000/1000 (100.0%), ")


# --- the worker pool -----------------------------------------------------------

def test_workers_limits_and_dedupe() -> None:
    lock = threading.Lock()
    running = {"all": 0, "video": 0}
    peak = {"all": 0, "video": 0}

    def task(video: bool) -> int:
        with lock:
            running["all"] += 1
            running["video"] += video
            for k in peak:
                peak[k] = max(peak[k], running[k])
        time.sleep(0.02)
        with lock:
            running["all"] -= 1
            running["video"] -= video
        return video

    with Workers(3, 1) as workers:
        for n in range(12):
            assert workers.submit(n, task, n % 2 == 0, video=n % 2 == 0)
        assert not workers.submit(0, task, True, video=True)
        assert [workers.result(n) for n in range(12)] == \
            [n % 2 == 0 for n in range(12)]
    assert peak == {"all": 3, "video": 1}


@pytest.mark.parametrize("value", ["0", "-2", "two"])
def test_jobs_must_be_positive(value: str, tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as exc:
        media_main(["ship", str(tmp_path), str(tmp_path / "o"), "--list",
                    "x.json", "--jobs", value])
    assert exc.value.code == 2


# --- poster size read from the JPEG XL header ----------------------------------

@pytest.mark.parametrize("size", [(1, 1), (8, 8), (7, 9), (1920, 1080),
                                  (1280, 720), (513, 1000), (1000, 513),
                                  (4000, 3), (96, 64), (1600, 900)])
def test_jxl_header_size_matches_decode(size: tuple[int, int]) -> None:
    width, height = size
    pixels = numpy.random.default_rng(width * height).integers(
        0, 255, (height, width, 3), dtype=numpy.uint8)
    data = media_tools.jxl_encode_lossless(pixels, effort=1)
    decoded = media_tools.jxl_decode(data).shape
    assert jxl_codestream_size(data[:64]) == (decoded[1], decoded[0]) == size
    assert jxl_codestream_size(b"\xff\x0a") is None
    assert jxl_codestream_size(b"\x89PNG") is None
