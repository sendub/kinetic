"""Lossless video posters (docs/extracting.md, "Posters").

A poster is the frame at the video's ``startSeconds``, saved by Pillow as
an RGB PNG with fixed params, then put through the still-image rule:
verified lossless JPEG XL when strictly smaller, else the PNG. The ledger
holds the ``poster`` step and the ``jxl``/``preserve`` step after it, so
``kinetic-media rebuild`` makes the same bytes. Ledgers from before (a
``poster`` step with ``jpeg`` params) still rebuild to their JPEG bytes.
Re-shipping the same list into a JPEG-poster shipment makes new posters
without making any video again, points the requests at them, and
reports (or with ``--delete-unreferenced-posters`` deletes) the old
poster files no request names.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy
import pytest

from helpers import open_image
from kinetic_extract import assets, media_tools
from kinetic_extract.media_cli import main as media_main

LEDGER = "media-ledger.json"
START = 1.0
COPY = {"source": {"path": "clips/h264.mp4"}, "kind": "video",
        "startSeconds": START}
TRANSCODE = {"source": {"path": "clips/mpeg4.mp4"}, "kind": "video"}


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _encode(out: Path, *args: str) -> Path:
    """A 2 s clip whose every frame differs (testsrc moves and counts)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi",
         "-i", "testsrc=size=96x54:rate=10:duration=2", *args, str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


@pytest.fixture
def root(tmp_path: Path) -> Path:
    game = tmp_path / "game"
    _encode(game / "clips" / "h264.mp4", "-c:v", "libx264",
            "-pix_fmt", "yuv420p")
    _encode(game / "clips" / "mpeg4.mp4", "-c:v", "mpeg4")
    return game


def ship(root: Path, out: Path, requests: list[dict], *extra: str) -> int:
    listing = out.parent / f"{out.name}-list.json"
    listing.write_text(json.dumps(requests), encoding="utf-8")
    return media_main(["ship", str(root), str(out), "--list", str(listing),
                       *extra])


def ledger_of(out: Path) -> dict:
    return json.loads((out / LEDGER).read_text("utf-8"))


def frame_pixels(video: Path, start: float, tmp: Path) -> bytes:
    """The RGB pixels of ffmpeg's frame at `start` (the poster's input)."""
    frame = tmp / f"frame-{start}.png"
    assert assets.ffmpeg_error(assets.frame_args(start), video, frame) \
        is None
    return open_image(frame).convert("RGB").tobytes()


def png_poster(video: Path, start: float, tmp: Path) -> bytes:
    png = tmp / f"poster-{start}.png"
    assert assets.run_poster_step(assets.poster_step(start), video,
                                  png) is None
    return png.read_bytes()


# --- new posters ------------------------------------------------------------

def test_poster_is_the_frame_at_start_seconds_lossless(
        root: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert ship(root, out, [COPY]) == 0
    (entry,) = ledger_of(out)["requests"]
    poster = entry["result"]["poster"]
    ext = poster.rsplit(".", 1)[1]
    assert ext in ("png", "jxl")
    video = root / "clips" / "h264.mp4"
    shipped = open_image(out / poster).convert("RGB").tobytes()
    assert shipped == frame_pixels(video, START, tmp_path)
    assert shipped != frame_pixels(video, 0.0, tmp_path)
    assert (entry["result"]["width"], entry["result"]["height"]) == (96, 54)


def test_jxl_only_when_smaller_and_pixel_identical(
        root: Path, tmp_path: Path) -> None:
    video = root / "clips" / "h264.mp4"
    png = png_poster(video, START, tmp_path)
    made = assets.extract_poster(video, START)
    assert made.error is None and made.steps is not None
    step, rule = made.steps
    assert step == assets.poster_step(START)
    if made.ext == "jxl":
        assert rule["step"] == "jxl" and rule["mode"] == "lossless"
        assert len(made.data) < len(png)
        back = media_tools.jxl_decode(made.data)
        assert numpy.array_equal(
            back, numpy.asarray(open_image(tmp_path / f"poster-{START}.png")))
    else:
        assert made.ext == "png" and made.data == png
        assert rule["step"] == "preserve"


def test_png_ships_when_jxl_is_not_smaller(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real = media_tools.jxl_encode_lossless

    def bigger(pixels, effort):
        return real(pixels, effort=effort) + b"\0" * 10_000_000

    monkeypatch.setattr(media_tools, "jxl_encode_lossless", bigger)
    video = root / "clips" / "h264.mp4"
    made = assets.extract_poster(video, START)
    assert made.ext == "png"
    assert made.data == png_poster(video, START, tmp_path)
    step, rule = made.steps
    assert rule["step"] == "preserve" and ">= original" in rule["reason"]


def test_ledger_recipe_is_complete_and_rebuilds(root: Path,
                                                tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert ship(root, out, [COPY, TRANSCODE]) == 0
    ledger = ledger_of(out)
    for entry in ledger["requests"]:
        media = ledger["media"][entry["result"]["poster"]]
        assert media["kind"] == "poster"
        step, rule = media["steps"]
        start = entry["request"].get("startSeconds", 0.0)
        assert step == {"step": "poster", "startSeconds": start,
                        "args": assets.frame_args(start),
                        "frameFormat": "png", "mode": "RGB",
                        "png": {"optimize": True}}
        assert rule["step"] in ("jxl", "preserve")
        assert {"ffmpeg", "Pillow"} <= set(media["tools"])
        if rule["step"] == "jxl":
            assert "libjxl" in media["tools"]
    assert media_main(["rebuild", str(root), str(out)]) == 0


# --- an old (JPEG poster) shipment -------------------------------------------

def make_jpeg_shipment(out: Path, root: Path) -> list[str]:
    """Turn a fresh ship into what the converter wrote before lossless
    posters: each poster a JPEG made by the old recipe (exactly what the
    old code ran: ``jpeg_poster_step`` through ``run_poster_step``),
    its ledger entry that recipe, the requests naming it. Returns the
    JPEG refs."""
    ledger = ledger_of(out)
    tools = ledger["mediaTools"]
    renamed: dict[str, str] = {}
    for ref, entry in list(ledger["media"].items()):
        if entry["kind"] != "poster":
            continue
        start = entry["steps"][0]["startSeconds"]
        step = assets.jpeg_poster_step(start)
        jpg = out / "old.jpg"
        assert assets.run_poster_step(step, root / entry["source"]["path"],
                                      jpg) is None
        data = jpg.read_bytes()
        new_ref = f"media/{_sha(data)[:2]}/{_sha(data)}.jpg"
        (out / new_ref).parent.mkdir(parents=True, exist_ok=True)
        jpg.replace(out / new_ref)
        (out / ref).unlink()
        del ledger["media"][ref]
        ledger["media"][new_ref] = {
            "kind": "poster", "sha256": _sha(data), "bytes": len(data),
            "source": entry["source"], "steps": [step],
            "tools": {"ffmpeg": tools["ffmpeg"]["version"],
                      "Pillow": tools["Pillow"]}}
        renamed[ref] = new_ref
    for entry in ledger["requests"]:
        entry["result"]["poster"] = renamed[entry["result"]["poster"]]
    ledger["media"] = dict(sorted(ledger["media"].items()))
    (out / LEDGER).write_text(json.dumps(ledger, indent=2) + "\n",
                              encoding="utf-8")
    return sorted(renamed.values())


def test_old_jpeg_poster_ledger_still_rebuilds(root: Path,
                                               tmp_path: Path) -> None:
    out = tmp_path / "out"
    assert ship(root, out, [COPY, TRANSCODE]) == 0
    jpegs = make_jpeg_shipment(out, root)
    assert len(jpegs) == 2
    assert media_main(["rebuild", str(root), str(out)]) == 0
    rebuilt = tmp_path / "rebuilt"
    assert media_main(["rebuild", str(root), str(out), "--out",
                       str(rebuilt)]) == 0
    for ref in jpegs:
        assert (rebuilt / ref).read_bytes() == (out / ref).read_bytes()


def _spy_file_steps(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    real = assets.run_file_step

    def spy(step, source, out):
        calls.append(step["step"])
        return real(step, source, out)

    monkeypatch.setattr(assets, "run_file_step", spy)
    return calls


def test_reship_regenerates_posters_without_redoing_videos(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    out = tmp_path / "out"
    requests = [COPY, TRANSCODE]
    assert ship(root, out, requests) == 0
    jpegs = make_jpeg_shipment(out, root)
    videos = {e["result"]["file"]: (out / e["result"]["file"]).stat()
              .st_mtime_ns for e in ledger_of(out)["requests"]}

    # No reuse cache at all (another machine, or it was cleared): the
    # ledger alone keeps the transcode from running again.
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    calls = _spy_file_steps(monkeypatch)
    capsys.readouterr()
    assert ship(root, out, requests) == 0
    summary = capsys.readouterr().out
    assert calls == ["poster", "poster"]
    ledger = ledger_of(out)
    posters = [e["result"]["poster"] for e in ledger["requests"]]
    assert all(p.rsplit(".", 1)[1] in ("png", "jxl") for p in posters)
    assert [e["request"] for e in ledger["requests"]] == requests
    for ref, mtime in videos.items():
        assert (out / ref).stat().st_mtime_ns == mtime  # left untouched
        assert ref in [e["result"]["file"] for e in ledger["requests"]]
    # Old JPEGs: kept, still in the ledger, counted.
    assert all((out / ref).is_file() and ref in ledger["media"]
               for ref in jpegs)
    assert "unreferenced posters: 2 kept" in summary
    assert media_main(["rebuild", str(root), str(out)]) == 0

    # Again: nothing is made at all, the folder is unchanged.
    before = {p: p.read_bytes() for p in out.rglob("*") if p.is_file()}
    calls.clear()
    assert ship(root, out, requests) == 0
    assert calls == []
    assert {p: p.read_bytes() for p in out.rglob("*") if p.is_file()} \
        == before

    # Opt-in deletion removes the JPEGs and their entries, nothing else.
    capsys.readouterr()
    assert ship(root, out, requests, "--delete-unreferenced-posters") == 0
    assert "unreferenced posters: 2 deleted" in capsys.readouterr().out
    ledger = ledger_of(out)
    for ref in jpegs:
        assert not (out / ref).exists() and ref not in ledger["media"]
    for entry in ledger["requests"]:
        assert (out / entry["result"]["poster"]).is_file()
        assert (out / entry["result"]["file"]).is_file()
    assert media_main(["rebuild", str(root), str(out)]) == 0


def test_delete_keeps_posters_other_requests_still_name(
        root: Path, tmp_path: Path) -> None:
    """A partial re-ship: the request left out of the new list keeps its
    JPEG poster, which stays (and is not counted)."""
    out = tmp_path / "out"
    assert ship(root, out, [COPY, TRANSCODE]) == 0
    make_jpeg_shipment(out, root)
    kept = ledger_of(out)["requests"][1]["result"]["poster"]
    assert ship(root, out, [COPY], "--delete-unreferenced-posters") == 0
    ledger = ledger_of(out)
    assert ledger["requests"][1]["result"]["poster"] == kept
    assert (out / kept).is_file() and kept in ledger["media"]
    assert ledger["requests"][0]["result"]["poster"].rsplit(".", 1)[1] \
        in ("png", "jxl")
    assert media_main(["rebuild", str(root), str(out)]) == 0
