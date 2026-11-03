"""Odd-dimension videos (H.264 yuv420p needs even width and height).

A transcode of an odd-sized source pads it to even, repeating the last
column/row (no border, no source pixel lost), with the exact filter in
the ledger step's ``args``; rebuild reruns that recorded recipe to the
same bytes. Even-sized transcodes keep the plain recipe and bytes, and
odd-sized streams that only need a new container are still remuxed.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from kinetic_extract import assets, media_tools
from kinetic_extract.media_cli import main as media_main

LEDGER = "media-ledger.json"


def _encode(out: Path, size: str, *args: str) -> Path:
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", f"testsrc=size={size}:rate=10:duration=0.5", *args,
         str(out)], capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


AV1 = ("-c:v", "libaom-av1", "-cpu-used", "8", "-pix_fmt", "yuv420p")


@pytest.fixture(scope="module")
def shipped(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """One `kinetic-media ship` of odd and even AV1/MPEG-4 clips and an
    odd H.264 (4:4:4) MKV."""
    root = tmp_path_factory.mktemp("odd")
    game = root / "game"
    game.mkdir()
    _encode(game / "odd.mp4", "180x101", *AV1)
    _encode(game / "even.mp4", "180x100", *AV1)
    _encode(game / "odd-mpeg4.mp4", "63x37", "-c:v", "mpeg4")
    _encode(game / "odd-h264.mkv", "63x37", "-c:v", "libx264",
            "-pix_fmt", "yuv444p")
    names = ["odd.mp4", "even.mp4", "odd-mpeg4.mp4", "odd-h264.mkv"]
    requests = [{"source": {"path": f"game/{n}"}, "kind": "video", "id": n}
                for n in names]
    listing = root / "requests.json"
    listing.write_text(json.dumps(requests), encoding="utf-8")
    out = root / "out"
    assert media_main(["ship", str(root), str(out), "--list",
                       str(listing)]) == 0
    ledger = json.loads((out / LEDGER).read_text("utf-8"))
    by_source = {}
    for file, entry in ledger["media"].items():
        if entry["kind"] == "video":
            by_source[Path(entry["source"]["path"]).name] = (file, entry)
    return {"root": root, "out": out, "game": game, "videos": by_source}


def _dims(path: Path) -> tuple[int, int]:
    proc = subprocess.run(
        [*media_tools.ffprobe_cmd(), "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", str(path)],
        capture_output=True, text=True, check=True)
    stream = json.loads(proc.stdout)["streams"][0]
    return stream["width"], stream["height"]


def _decodes(path: Path) -> bool:
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-xerror", "-i", str(path),
         "-f", "null", "-"], capture_output=True, text=True, check=False)
    return proc.returncode == 0


def _luma(path: Path, width: int, height: int) -> list[bytes]:
    """The first frame's Y plane, one bytes per row."""
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-i", str(path), "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True, check=True)
    y = proc.stdout
    assert len(y) == width * height
    return [y[r * width:(r + 1) * width] for r in range(height)]


@pytest.mark.parametrize(("name", "src", "even"), [
    ("odd.mp4", (180, 101), (180, 102)),
    ("odd-mpeg4.mp4", (63, 37), (64, 38)),
])
def test_odd_source_transcodes_padded_to_even(
        shipped: dict, name: str, src: tuple[int, int],
        even: tuple[int, int]) -> None:
    file, entry = shipped["videos"][name]
    out = shipped["out"] / file
    (step,) = entry["steps"]
    assert step["step"] == "transcode"
    args = step["args"]
    w, h = src
    chain = args[args.index("-vf") + 1]
    assert chain == (f"format=yuv444p,pad={even[0]}:{even[1]}:0:0,"
                     f"fillborders=left=0:right={even[0] - w}:top=0:"
                     f"bottom={even[1] - h}:mode=smear")
    assert args.index("-vf") > args.index("-i")
    assert f"{w}x{h}" in step["reason"]
    assert _dims(out) == even
    assert _decodes(out)
    rows = _luma(out, *even)
    # The added row repeats the last source row (a copy, not a border).
    diff = sum(abs(a - b) for a, b in zip(rows[-1], rows[-2])) / even[0]
    assert diff < 3


def test_odd_transcode_is_repeatable(shipped: dict, tmp_path: Path) -> None:
    """The recorded recipe gives the same bytes on every run."""
    file, entry = shipped["videos"]["odd.mp4"]
    (step,) = entry["steps"]
    hashes = set()
    for n in range(4):
        out = tmp_path / f"again-{n}.mp4"
        assert assets.run_file_step(step, shipped["game"] / "odd.mp4",
                                    out) is None
        hashes.add(hashlib.sha256(out.read_bytes()).hexdigest())
    assert hashes == {entry["sha256"]}


def test_even_transcode_keeps_plain_recipe_and_bytes(
        shipped: dict, tmp_path: Path) -> None:
    file, entry = shipped["videos"]["even.mp4"]
    (step,) = entry["steps"]
    assert step == {"step": "transcode", "args": assets.transcode_args()}
    assert "-vf" not in step["args"]
    assert step == assets.transcode_step()
    plain = tmp_path / "plain.mp4"
    assert assets.run_file_step(assets.transcode_step(),
                                shipped["game"] / "even.mp4", plain) is None
    assert hashlib.sha256(plain.read_bytes()).hexdigest() \
        == entry["sha256"]
    assert _dims(shipped["out"] / file) == (180, 100)


def test_odd_h264_in_mkv_still_remuxes(shipped: dict) -> None:
    file, entry = shipped["videos"]["odd-h264.mkv"]
    (step,) = entry["steps"]
    assert step["step"] == "remux"
    assert "-vf" not in step["args"] and "libx264" not in step["args"]
    assert _dims(shipped["out"] / file) == (63, 37)


def test_odd_video_poster_keeps_source_size(shipped: dict) -> None:
    posters = {Path(e["source"]["path"]).name: f
               for f, e in json.loads((shipped["out"] / LEDGER)
                                      .read_text("utf-8"))["media"].items()
               if e["kind"] == "poster"}
    with Image.open(shipped["out"] / posters["odd.mp4"]) as img:
        assert img.size == (180, 101)


def test_rebuild_reproduces_odd_and_even(shipped: dict) -> None:
    assert media_main(["rebuild", str(shipped["root"]),
                       str(shipped["out"])]) == 0


def test_rebuild_runs_the_recorded_recipe_not_a_new_one(
        shipped: dict, tmp_path: Path) -> None:
    """An odd source rebuilt from a ledger step without the filter (an old
    recipe) runs that step as recorded: it fails as it always did."""
    work = tmp_path / "work"
    work.mkdir()
    with pytest.raises(assets.StepError, match="transcode failed"):
        assets.run_steps([assets.transcode_step()],
                         shipped["game"] / "odd.mp4",
                         {"path": "game/odd.mp4"}, [], work)


@pytest.mark.parametrize(("w", "h", "chain"), [
    (180, 100, None), (None, 101, None), (180, None, None),
    (181, 100, "format=yuv444p,pad=182:100:0:0,"
               "fillborders=left=0:right=1:top=0:bottom=0:mode=smear"),
    (181, 101, "format=yuv444p,pad=182:102:0:0,"
               "fillborders=left=0:right=1:top=0:bottom=1:mode=smear"),
])
def test_even_pad_filter_only_for_odd(w, h, chain) -> None:
    assert assets.even_pad_filter(w, h) == chain
