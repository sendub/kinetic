"""`kinetic-media posters` (docs/plan.md Phase 44, item 1; Phase 45).

A video item's poster must be the frame at its ``startSeconds``
(docs/content-format.md, "Video playback ranges"). The check passes a
poster whose ledger entry records a ``poster`` step made from the
item's video source at that start, and compares pixels when the ledger
cannot say. It writes nothing. ``--fix`` ships one poster per distinct
(video source, startSeconds) through the ship code and writes the remap
(item id -> new poster) and the requests it shipped; a second ``--fix``
changes nothing, and the remapped manifest passes.

Phase 45: ``--items FILE`` limits the check and the fix to the listed
item ids, and each ``FAIL`` line ends with the mean Rec. 601 luma of the
start frame and of the poster, plus ``dark start`` when the start frame
is below ``DARK_START_LUMA``.

Phase 60 item 9n6: a video that holds its last frame has its
``lastFrame`` checked the same way, against its range's last frame, and
``--fix`` ships the right one, its new path in ``--last-frame-remap``
while ``--remap`` stays item id -> new poster.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import numpy
import pytest

import extra_hook
from helpers import content_ref, open_image
from kinetic_extract import assets, media_tools, posters
from kinetic_extract.media_cli import main as media_main

HERE = Path(__file__).resolve().parent
HOOK_FILE = HERE / "extra_hook.py"
LEDGER = "media-ledger.json"
A = {"source": {"path": "clips/a.mp4"}, "kind": "video"}   # H.264: copied
B = {"source": {"path": "clips/b.mp4"}, "kind": "video"}   # MPEG-4: transcoded


def _encode(out: Path, seed: int, *codec: str) -> Path:
    """A 3 s clip whose whole picture changes over time (a moving colour
    gradient). Measured with ffmpeg 6.1 and the pinned build: frame 0 and
    the frames at 1 s and 2 s differ by a mean of 8.6 to 103 per
    channel, a correct JPEG q90 poster (against the source or the
    transcode) by at most 1.5, far either side of the tolerance."""
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        [*media_tools.ffmpeg_cmd(), "-y", "-f", "lavfi", "-i",
         f"gradients=size=160x90:rate=10:duration=3:speed=0.15:seed={seed}",
         *codec, str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr
    return out


@pytest.fixture
def root(tmp_path: Path) -> Path:
    game = tmp_path / "game"
    _encode(game / "clips" / "a.mp4", 7, "-c:v", "libx264",
            "-pix_fmt", "yuv420p")
    _encode(game / "clips" / "b.mp4", 3, "-c:v", "mpeg4")
    return game


def at(request: dict, start: float) -> dict:
    return dict(request, startSeconds=start)


def ledger_of(folder: Path) -> dict:
    return json.loads((folder / LEDGER).read_text("utf-8"))


def ship(root: Path, folder: Path, requests: list[dict],
         *extra: str) -> list[dict]:
    """Ship `requests` into `folder`; their results, in order."""
    listing = folder.parent / f"{folder.name}-list.json"
    listing.write_text(json.dumps(requests), encoding="utf-8")
    assert media_main(["ship", str(root), str(folder), "--list",
                       str(listing), *extra]) == 0
    listing.unlink()
    results = {json.dumps(e["request"], sort_keys=True): e["result"]
               for e in ledger_of(folder)["requests"]}
    return [results[json.dumps(r, sort_keys=True)] for r in requests]


def video(item_id: str, result: dict, start: float | None = None) -> dict:
    item = {"id": item_id, "type": "video", "file": result["file"],
            "poster": result["poster"],
            "durationSeconds": result["durationSeconds"]}
    if start is not None:
        item["startSeconds"] = start
    return item


def write_manifest(path: Path, items: list[dict],
                   branches: list[dict] | None = None) -> Path:
    manifest: dict = {"schemaVersion": 1, "width": 160, "height": 90,
                      "items": items}
    if branches:
        manifest["branches"] = branches
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def run(root: Path, folder: Path, *extra: str) -> int:
    return media_main(["posters", str(root), str(folder), *extra])


def snapshot(top: Path) -> dict[str, tuple[bytes, int]]:
    """Every file under `top`: its bytes and mtime."""
    return {str(p.relative_to(top)): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in sorted(top.rglob("*")) if p.is_file()}


def contents(top: Path) -> dict[str, bytes]:
    return {str(p.relative_to(top)): p.read_bytes()
            for p in sorted(top.rglob("*")) if p.is_file()}


def fails(out: str) -> dict[str, str]:
    """FAIL lines of a report by item id."""
    found = {}
    for line in out.splitlines():
        if line.startswith("FAIL "):
            item_id, _, rest = line[len("FAIL "):].partition(": ")
            found[item_id] = rest
    return found


def summary(out: str) -> str:
    (line,) = [ln for ln in out.splitlines() if ln.startswith("posters: ")]
    return line


def frame_image(video_path: Path, start: float, tmp: Path):
    frame = tmp / f"frame-{video_path.stem}-{start}.png"
    assert assets.ffmpeg_error(assets.frame_args(start), video_path,
                               frame) is None
    return open_image(frame).convert("RGB")


def frame_pixels(video_path: Path, start: float, tmp: Path) -> bytes:
    return frame_image(video_path, start, tmp).tobytes()


def mean_luma(image) -> float:
    """Mean Rec. 601 luma (0.299 R + 0.587 G + 0.114 B, 0-255)."""
    pixels = numpy.asarray(image.convert("RGB"), dtype=numpy.float64)
    return float((pixels @ [0.299, 0.587, 0.114]).mean())


def spy_ffmpeg(monkeypatch: pytest.MonkeyPatch) -> list[list[str]]:
    """Every pinned-ffmpeg run (frame decodes, posters, transcodes)."""
    calls: list[list[str]] = []
    real = assets.ffmpeg_error

    def spy(args, source, out):
        calls.append(list(args))
        return real(args, source, out)

    monkeypatch.setattr(assets, "ffmpeg_error", spy)
    return calls


def spy_file_steps(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []
    real = assets.run_file_step

    def spy(step, source, out):
        calls.append(step["step"])
        return real(step, source, out)

    monkeypatch.setattr(assets, "run_file_step", spy)
    return calls


# --- 1. correct posters: exit 0, nothing written -----------------------------

def test_correct_posters_pass_by_ledger_and_nothing_is_written(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = tmp_path / "folder"
    a1, a2, b0, b1 = ship(root, folder, [at(A, 1.0), at(A, 2.0), B,
                                         at(B, 1.0)])
    write_manifest(folder / "manifest.json", [
        video("a1", a1, 1.0), video("a2", a2, 2.0), video("b0", b0),
        video("b0-explicit", b0, 0), video("b1", b1, 1.0)])
    before = snapshot(tmp_path)
    calls = spy_ffmpeg(monkeypatch)
    capsys.readouterr()

    assert run(root, folder) == 0

    out = capsys.readouterr().out
    assert fails(out) == {}
    assert summary(out) == ("posters: 5 video items: 5 checked, 5 passed "
                            "(5 by ledger, 0 by pixels), 0 failed, "
                            "0 skipped (first frame)")
    assert calls == []  # passing by ledger decodes nothing
    assert snapshot(tmp_path) == before  # folder, ledger, cache untouched


# --- 2. frame-0 posters on later-start items ---------------------------------

def frame0_folder(root: Path, tmp_path: Path) -> tuple[Path, Path]:
    """What the converting agent had: posters shipped at frame 0 for
    items that start later. x1 and x2 share (a, 1.0); x3 is a later
    start in the same file and sits in a route; y1 is the transcoded
    video. `ok` really starts at 0."""
    folder = tmp_path / "folder"
    a0, b0 = ship(root, folder, [A, B])
    manifest = write_manifest(folder / "manifest.json", [
        video("ok", a0), video("x1", a0, 1.0), video("x2", a0, 1.0),
        video("x3", a0, 2.0), video("y1", b0, 1.0)],
        branches=[{"id": "pick", "after": "ok", "prompt": "Which?",
                   "routes": [{"id": "r1", "label": "One", "start": "x1",
                               "end": "x2"},
                              {"id": "r2", "label": "Two", "start": "x3",
                               "end": "x3", "result": "continue"}],
                   "continuingRoute": "r1", "continueAt": "y1"}])
    return folder, manifest


def apply_remap(manifest: Path, remap: dict[str, str]) -> None:
    data = json.loads(manifest.read_text("utf-8"))
    for item in data["items"]:
        if item["id"] in remap:
            item["poster"] = remap[item["id"]]
    manifest.write_text(json.dumps(data, indent=2), encoding="utf-8")


def test_frame0_posters_are_reported_and_fixed(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder, manifest = frame0_folder(root, tmp_path)
    before = snapshot(tmp_path)
    capsys.readouterr()

    assert run(root, folder) == 1

    out = capsys.readouterr().out
    found = fails(out)
    assert sorted(found) == ["x1", "x2", "x3", "y1"]
    items = {i["id"]: i for i in json.loads(manifest.read_text())["items"]}
    for item_id, rest in found.items():
        item = items[item_id]
        assert rest.startswith(
            f"file {item['file']}, startSeconds {item['startSeconds']}, "
            "poster startSeconds 0.0, difference ")
        difference = float(rest.split("difference ")[1].split(" ")[0])
        assert difference > posters.POSTER_TOLERANCE
    assert summary(out) == ("posters: 5 video items: 5 checked, 1 passed "
                            "(1 by ledger, 0 by pixels), 4 failed, "
                            "0 skipped (first frame)")
    assert snapshot(tmp_path) == before

    # The fix: one poster per distinct (video source, startSeconds), the
    # transcode reused, not made again.
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    steps = spy_file_steps(monkeypatch)
    remap_file, out_file = tmp_path / "remap.json", tmp_path / "requests.json"
    assert run(root, folder, "--fix", "--remap", str(remap_file),
               "--out", str(out_file)) == 0
    assert steps == ["poster", "poster", "poster"]
    requests = json.loads(out_file.read_text("utf-8"))
    assert requests == [at(A, 1.0), at(A, 2.0), at(B, 1.0)]
    remap = json.loads(remap_file.read_text("utf-8"))
    assert list(remap) == ["x1", "x2", "x3", "y1"]
    assert remap["x1"] == remap["x2"] != remap["x3"]
    for item_id, start, source in (("x1", 1.0, "a"), ("x3", 2.0, "a"),
                                   ("y1", 1.0, "b")):
        shipped = open_image(folder / remap[item_id]).convert("RGB")
        assert shipped.tobytes() == frame_pixels(
            root / "clips" / f"{source}.mp4", start, tmp_path)
    assert media_main(["rebuild", str(root), str(folder)]) == 0

    # The caller applies the remap; the check then passes.
    apply_remap(manifest, remap)
    capsys.readouterr()
    assert run(root, folder) == 0
    assert "5 passed (5 by ledger, 0 by pixels), 0 failed" in \
        summary(capsys.readouterr().out)


def test_poster_of_another_video_fails(root: Path, tmp_path: Path,
                                      capsys: pytest.CaptureFixture[str]
                                      ) -> None:
    folder = tmp_path / "folder"
    a1, b1 = ship(root, folder, [at(A, 1.0), at(B, 1.0)])
    write_manifest(folder / "manifest.json", [
        dict(video("mixed", a1, 1.0), poster=b1["poster"])])
    capsys.readouterr()
    assert run(root, folder) == 1
    found = fails(capsys.readouterr().out)
    assert list(found) == ["mixed"]
    assert "poster startSeconds 1.0" in found["mixed"]
    assert "(ledger: poster made from another source), start luma " in \
        found["mixed"]
    remap = tmp_path / "remap.json"
    assert run(root, folder, "--fix", "--remap", str(remap)) == 0
    assert json.loads(remap.read_text("utf-8")) == {"mixed": a1["poster"]}


def test_check_reads_a_staged_manifest(root: Path, tmp_path: Path,
                                       capsys: pytest.CaptureFixture[str]
                                       ) -> None:
    folder, manifest = frame0_folder(root, tmp_path)
    staged = tmp_path / "staged" / "manifest.json"
    staged.parent.mkdir()
    manifest.rename(staged)
    capsys.readouterr()
    assert run(root, folder, "--manifest", str(staged)) == 1
    assert sorted(fails(capsys.readouterr().out)) == ["x1", "x2", "x3", "y1"]


# --- 3. --fix twice ----------------------------------------------------------

def test_second_fix_changes_nothing(root: Path, tmp_path: Path,
                                    monkeypatch: pytest.MonkeyPatch) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    first_remap, first_out = tmp_path / "remap1.json", tmp_path / "out1.json"
    assert run(root, folder, "--fix", "--remap", str(first_remap),
               "--out", str(first_out)) == 0
    after_first = contents(folder)

    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    steps = spy_file_steps(monkeypatch)
    remap, out = tmp_path / "remap2.json", tmp_path / "out2.json"
    assert run(root, folder, "--fix", "--remap", str(remap),
               "--out", str(out)) == 0
    assert steps == []  # every poster and the transcode reused
    assert contents(folder) == after_first
    assert remap.read_bytes() == first_remap.read_bytes()
    assert out.read_bytes() == first_out.read_bytes()


# --- 4. first-frame exception ------------------------------------------------

def test_first_frame_files_are_skipped(root: Path, tmp_path: Path,
                                       capsys: pytest.CaptureFixture[str]
                                       ) -> None:
    folder, manifest = frame0_folder(root, tmp_path)
    items = {i["id"]: i for i in json.loads(manifest.read_text())["items"]}
    a_file, b_file = items["x1"]["file"], items["y1"]["file"]
    capsys.readouterr()

    assert run(root, folder, "--first-frame", a_file) == 1
    out = capsys.readouterr().out
    assert sorted(fails(out)) == ["y1"]
    assert summary(out).endswith("1 checked, 0 passed (0 by ledger, 0 by "
                                 "pixels), 1 failed, 4 skipped (first "
                                 "frame)")

    assert run(root, folder, "--first-frame", a_file,
               "--first-frame", b_file) == 0
    out = capsys.readouterr().out
    assert fails(out) == {}
    assert "5 skipped (first frame)" in summary(out)

    assert run(root, folder, "--first-frame-all") == 0
    out = capsys.readouterr().out
    assert fails(out) == {}
    assert "0 checked" in summary(out) and "5 skipped" in summary(out)

    # Skipped items are never fixed.
    before = contents(folder)
    remap = tmp_path / "remap.json"
    assert run(root, folder, "--first-frame-all", "--fix",
               "--remap", str(remap)) == 0
    assert json.loads(remap.read_text("utf-8")) == {}
    assert contents(folder) == before


# --- 5. the pixel check ------------------------------------------------------

def place(folder: Path, data: bytes, ext: str) -> str:
    """Put a hand-made file into the folder's media/ (no ledger entry)."""
    ref = content_ref(data, ext)
    (folder / ref).parent.mkdir(parents=True, exist_ok=True)
    (folder / ref).write_bytes(data)
    return ref


def jpeg_poster(video_path: Path, start: float, tmp: Path) -> bytes:
    """A JPEG q90 poster by the older recipe, at `start`."""
    out = tmp / f"old-{video_path.stem}-{start}.jpg"
    assert assets.run_poster_step(assets.jpeg_poster_step(start), video_path,
                                  out) is None
    return out.read_bytes()


def test_posters_without_ledger_entries_are_checked_by_pixels(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    folder = tmp_path / "folder"
    a1, b1 = ship(root, folder, [at(A, 1.0), at(B, 1.0)])
    a, b = root / "clips" / "a.mp4", root / "clips" / "b.mp4"
    good_a = place(folder, jpeg_poster(a, 1.0, tmp_path), "jpg")
    bad_a = place(folder, jpeg_poster(a, 0.0, tmp_path), "jpg")
    good_b = place(folder, jpeg_poster(b, 1.0, tmp_path), "jpg")
    bad_b = place(folder, jpeg_poster(b, 0.0, tmp_path), "jpg")
    # b's video loses its ledger entry: its frame then comes from the
    # folder's shipped transcode, not the original MPEG-4.
    ledger = ledger_of(folder)
    del ledger["media"][b1["file"]]
    (folder / LEDGER).write_text(json.dumps(ledger, indent=2) + "\n",
                                 encoding="utf-8")
    write_manifest(folder / "manifest.json", [
        dict(video("a-good", a1, 1.0), poster=good_a),
        dict(video("a-bad", a1, 1.0), poster=bad_a),
        dict(video("b-good", b1, 1.0), poster=good_b),
        dict(video("b-bad", b1, 1.0), poster=bad_b),
        video("b-shipped", b1, 1.0)])   # its own poster, video unknown
    before = snapshot(tmp_path)
    capsys.readouterr()

    assert run(root, folder) == 1

    out = capsys.readouterr().out
    found = fails(out)
    assert sorted(found) == ["a-bad", "b-bad"]
    for rest in found.values():
        assert "poster startSeconds none" in rest
        difference = float(rest.split("difference ")[1].split(" ")[0])
        assert difference > posters.POSTER_TOLERANCE
    assert summary(out) == ("posters: 5 video items: 5 checked, 3 passed "
                            "(0 by ledger, 3 by pixels), 2 failed, "
                            "0 skipped (first frame)")
    assert snapshot(tmp_path) == before

    # A failure whose video has no ledger entry has no source to ship.
    remap = tmp_path / "remap.json"
    capsys.readouterr()
    assert run(root, folder, "--fix", "--remap", str(remap)) == 1
    out = capsys.readouterr().out
    assert [ln.split(":")[0] for ln in out.splitlines()
            if ln.startswith("NOT FIXABLE ")] == ["NOT FIXABLE b-bad"]
    remap_data = json.loads(remap.read_text("utf-8"))
    assert list(remap_data) == ["a-bad"]
    assert open_image(folder / remap_data["a-bad"]).convert(
        "RGB").tobytes() == frame_pixels(a, 1.0, tmp_path)


def test_poster_step_without_start_seconds_is_checked_by_pixels(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    """A hand-edited ledger whose poster steps record no startSeconds:
    the start is unknown (not 0), so the pixels decide."""
    folder = tmp_path / "folder"
    a1, a0 = ship(root, folder, [at(A, 1.0), A])
    ledger = ledger_of(folder)
    for entry in ledger["media"].values():
        for step in entry["steps"]:
            step.pop("startSeconds", None)
    (folder / LEDGER).write_text(json.dumps(ledger, indent=2) + "\n",
                                 encoding="utf-8")
    write_manifest(folder / "manifest.json", [
        video("good", a1, 1.0), dict(video("bad", a1, 1.0),
                                     poster=a0["poster"])])
    capsys.readouterr()

    assert run(root, folder) == 1

    out = capsys.readouterr().out
    found = fails(out)
    assert list(found) == ["bad"]
    assert "poster startSeconds none" in found["bad"]
    assert "2 checked, 1 passed (0 by ledger, 1 by pixels), 1 failed" in \
        summary(out)


def test_pixel_difference_is_zero_for_the_exact_frame(
        root: Path, tmp_path: Path) -> None:
    a = root / "clips" / "a.mp4"
    lossless = tmp_path / "poster.png"
    assert assets.run_poster_step(assets.poster_step(1.0), a,
                                  lossless) is None
    jpeg = tmp_path / "poster.jpg"
    jpeg.write_bytes(jpeg_poster(a, 1.0, tmp_path))
    frame0 = tmp_path / "frame0.jpg"
    frame0.write_bytes(jpeg_poster(a, 0.0, tmp_path))
    work = tmp_path / "work"
    work.mkdir()
    exact = posters.compare_pixels(lossless, a, 1.0, work)
    assert exact.difference == 0.0
    assert exact.start_luma == exact.poster_luma == mean_luma(
        open_image(lossless))
    assert posters.compare_pixels(jpeg, a, 1.0, work).difference \
        <= posters.POSTER_TOLERANCE
    assert posters.compare_pixels(frame0, a, 1.0, work).difference \
        > posters.POSTER_TOLERANCE


# --- ledgers -----------------------------------------------------------------

def test_default_reads_both_ledgers_merged(root: Path, tmp_path: Path,
                                           capsys: pytest.CaptureFixture[str]
                                           ) -> None:
    """A folder with build-ledger.json and media-ledger.json: their
    `media` sections are read together, as rebuild reads them; --ledger
    FILE reads only that file."""
    folder = tmp_path / "folder"
    (a1,) = ship(root, folder, [at(A, 1.0)])
    ledger = ledger_of(folder)
    poster_entries = {ref: e for ref, e in ledger["media"].items()
                      if e["kind"] == "poster"}
    for ref in poster_entries:
        del ledger["media"][ref]
    (folder / LEDGER).write_text(json.dumps(ledger), encoding="utf-8")
    (folder / "build-ledger.json").write_text(json.dumps(
        {"mediaTools": ledger["mediaTools"], "media": poster_entries}),
        encoding="utf-8")
    write_manifest(folder / "manifest.json", [video("a1", a1, 1.0)])
    capsys.readouterr()

    assert run(root, folder) == 0
    assert "1 passed (1 by ledger, 0 by pixels)" in \
        summary(capsys.readouterr().out)
    assert run(root, folder, "--ledger", str(folder / LEDGER)) == 0
    assert "1 passed (0 by ledger, 1 by pixels)" in \
        summary(capsys.readouterr().out)


def test_fix_refuses_a_ledger_it_would_not_ship_into(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    copy = tmp_path / "copy-ledger.json"
    copy.write_bytes((folder / LEDGER).read_bytes())
    before = snapshot(tmp_path)
    remap = tmp_path / "remap.json"
    capsys.readouterr()

    assert run(root, folder, "--ledger", str(copy), "--fix",
               "--remap", str(remap)) == 2
    (reason,) = [ln for ln in capsys.readouterr().err.splitlines()
                 if ln.startswith("kinetic-media: ")]
    assert "--fix" in reason and str(copy) in reason
    assert snapshot(tmp_path) == before
    # Check mode accepts any ledger.
    assert run(root, folder, "--ledger", str(copy)) == 1
    # Naming the folder's own media ledger is the same as the default.
    assert run(root, folder, "--ledger", str(folder / LEDGER), "--fix",
               "--remap", str(remap)) == 0


# --- decoder hooks -----------------------------------------------------------

def test_wrapped_video_is_checked_and_fixed_with_the_hook(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    clip = (root / "clips" / "a.mp4").read_bytes()
    (root / "clips" / "w.bin").write_bytes(extra_hook.wrap(clip))
    hook = f"{HOOK_FILE}:decode"
    wrapped = {"source": {"path": "clips/w.bin"}, "kind": "video"}
    folder = tmp_path / "folder"
    w0, w1 = ship(root, folder, [wrapped, at(wrapped, 1.0)], "--decoder",
                  hook)
    # A correct poster with no ledger entry: compared with the frame of
    # the decoded original source.
    good = place(folder, jpeg_poster(root / "clips" / "a.mp4", 2.0,
                                     tmp_path), "jpg")
    write_manifest(folder / "manifest.json", [
        video("ok", w1, 1.0), video("bad", w0, 1.0),
        dict(video("pixels", w0, 2.0), poster=good)])
    capsys.readouterr()

    assert run(root, folder, "--decoder", hook) == 1
    out = capsys.readouterr().out
    assert list(fails(out)) == ["bad"]
    assert "1 by ledger, 1 by pixels" in summary(out)

    remap = tmp_path / "remap.json"
    assert run(root, folder, "--decoder", hook, "--fix",
               "--remap", str(remap)) == 0
    assert json.loads(remap.read_text("utf-8")) == {"bad": w1["poster"]}


# --- 6. cannot start ---------------------------------------------------------

def test_cannot_start_exits_2(root: Path, tmp_path: Path,
                              capsys: pytest.CaptureFixture[str]) -> None:
    folder, manifest = frame0_folder(root, tmp_path)
    remap = tmp_path / "remap.json"
    empty = tmp_path / "empty"
    empty.mkdir()
    write_manifest(empty / "manifest.json", [])
    cases = [
        [str(root), str(folder), "--manifest", str(tmp_path / "none.json")],
        [str(root), str(empty)],                       # no ledger
        [str(root), str(folder), "--ledger", str(tmp_path / "none.json")],
        [str(tmp_path / "no-root"), str(folder)],
        [str(root), str(folder), "--fix"],             # no --remap
        [str(root), str(folder), "--remap", str(remap)],   # no --fix
        [str(root), str(folder), "--out", str(remap)],     # no --fix
        [str(root), str(folder), "--last-frame-remap", str(remap)],
    ]
    before = snapshot(tmp_path)
    for case in cases:
        capsys.readouterr()
        assert media_main(["posters", *case]) == 2, case
        assert capsys.readouterr().err.strip(), case
    assert snapshot(tmp_path) == before


# --- 7. --items: one shipment's items ----------------------------------------

def items_file(path: Path, ids: list[str], as_json: bool = True) -> Path:
    path.write_text(json.dumps(ids) if as_json else "\n".join(ids) + "\n",
                    encoding="utf-8")
    return path


def poster_starts(folder: Path) -> list[float]:
    """Every poster startSeconds the folder's media ledger records."""
    return sorted(step["startSeconds"]
                  for entry in ledger_of(folder)["media"].values()
                  for step in entry.get("steps", [])
                  if step.get("step") == "poster")


def test_items_limits_the_check_and_the_fix_to_the_listed_items(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    """x1, x2, x3 and y1 all fail; only x1 and y1 are listed. x2 needs
    the very poster x1's fix ships, and x3 one of its own: neither is
    reported, shipped or remapped."""
    folder, manifest = frame0_folder(root, tmp_path)
    listed = items_file(tmp_path / "shipment.json", ["x1", "y1"])
    before = snapshot(tmp_path)
    capsys.readouterr()

    assert run(root, folder, "--items", str(listed)) == 1

    out = capsys.readouterr().out
    assert sorted(fails(out)) == ["x1", "y1"]
    assert summary(out) == ("posters: 2 of 5 video items selected: "
                            "2 checked, 0 passed (0 by ledger, 0 by "
                            "pixels), 2 failed, 0 skipped (first frame)")
    assert snapshot(tmp_path) == before

    # --first-frame still applies inside the selection.
    items = {i["id"]: i for i in json.loads(manifest.read_text())["items"]}
    assert run(root, folder, "--items", str(listed),
               "--first-frame", items["x1"]["file"]) == 1
    out = capsys.readouterr().out
    assert list(fails(out)) == ["y1"]
    assert summary(out) == ("posters: 2 of 5 video items selected: "
                            "1 checked, 0 passed (0 by ledger, 0 by "
                            "pixels), 1 failed, 1 skipped (first frame)")

    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    steps = spy_file_steps(monkeypatch)
    remap_file, out_file = tmp_path / "remap.json", tmp_path / "requests.json"
    assert run(root, folder, "--items", str(listed), "--fix",
               "--remap", str(remap_file), "--out", str(out_file)) == 0
    assert steps == ["poster", "poster"]
    assert json.loads(out_file.read_text("utf-8")) == [at(A, 1.0),
                                                       at(B, 1.0)]
    remap = json.loads(remap_file.read_text("utf-8"))
    assert list(remap) == ["x1", "y1"]
    assert 2.0 not in poster_starts(folder)  # x3's poster was not made

    # The listed items now pass; the unlisted ones still fail.
    apply_remap(manifest, remap)
    capsys.readouterr()
    assert run(root, folder, "--items", str(listed)) == 0
    assert run(root, folder) == 1
    assert sorted(fails(capsys.readouterr().out)) == ["x2", "x3"]


def test_items_file_may_be_json_or_one_id_per_line(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    as_json = tmp_path / "items.json"
    as_json.write_text('\n  [\n "x3", "ok", "x3"\n]\n', encoding="utf-8")
    as_lines = tmp_path / "items.txt"
    as_lines.write_text("# shipment 3\n\n  x3  \n\tok\n   # not an id\n\n",
                        encoding="utf-8")
    reports = []
    for listed in (as_json, as_lines):
        capsys.readouterr()
        assert run(root, folder, "--items", str(listed)) == 1
        reports.append(capsys.readouterr().out)
    assert reports[0] == reports[1]
    assert list(fails(reports[0])) == ["x3"]
    assert summary(reports[0]).startswith(
        "posters: 2 of 5 video items selected: 2 checked, 1 passed ")


def test_unknown_item_ids_exit_2_and_are_named(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    typo = items_file(tmp_path / "typo.json", ["x1", "xl", "pick"])
    many = items_file(tmp_path / "many.txt",
                      ["x1", *(f"u{n:02}" for n in range(1, 13))],
                      as_json=False)
    remap = tmp_path / "remap.json"
    before = snapshot(tmp_path)

    capsys.readouterr()
    assert run(root, folder, "--items", str(typo)) == 2
    err = capsys.readouterr().err
    # "pick" is a branch id, not an item id.
    assert '"xl"' in err and '"pick"' in err and '"x1"' not in err
    assert str(typo) in err

    assert run(root, folder, "--items", str(many), "--fix",
               "--remap", str(remap)) == 2
    err = capsys.readouterr().err
    assert all(f'"u{n:02}"' in err for n in range(1, 11))
    assert '"u11"' not in err and '"u12"' not in err
    assert "12" in err and "2 more" in err
    assert snapshot(tmp_path) == before


def test_non_video_item_ids_are_ignored(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, manifest = frame0_folder(root, tmp_path)
    data = json.loads(manifest.read_text("utf-8"))
    data["items"].insert(0, {"id": "say", "type": "text",
                             "text": "It was raining."})
    manifest.write_text(json.dumps(data, indent=2), encoding="utf-8")
    capsys.readouterr()

    assert run(root, folder, "--items",
               str(items_file(tmp_path / "mixed.json", ["say", "x1"]))) == 1
    out = capsys.readouterr().out
    assert list(fails(out)) == ["x1"]
    assert summary(out).startswith("posters: 1 of 5 video items selected: "
                                   "1 checked, ")

    # Only non-video ids: nothing selected, which is not an error.
    text_only = items_file(tmp_path / "text.txt", ["say"], as_json=False)
    before = contents(folder)
    for extra in ([], ["--fix", "--remap", str(tmp_path / "remap.json")]):
        capsys.readouterr()
        assert run(root, folder, "--items", str(text_only), *extra) == 0
        out = capsys.readouterr().out
        assert fails(out) == {}
        assert summary(out) == ("posters: 0 of 5 video items selected: "
                                "0 checked, 0 passed (0 by ledger, 0 by "
                                "pixels), 0 failed, 0 skipped (first "
                                "frame)")
    assert json.loads((tmp_path / "remap.json").read_text("utf-8")) == {}
    assert contents(folder) == before


@pytest.mark.parametrize("text", ['["x1", "y1"', '["x1", 3]',
                                  '[["x1"]]', '  [{"id": "x1"}]'])
def test_malformed_json_items_file_exits_2(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str],
        text: str) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    listed = tmp_path / "items.json"
    listed.write_text(text, encoding="utf-8")
    capsys.readouterr()
    assert run(root, folder, "--items", str(listed)) == 2
    err = capsys.readouterr().err
    assert str(listed) in err
    assert run(root, folder, "--items", str(tmp_path / "none.json")) == 2


def test_fix_with_items_twice_changes_nothing(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder, _ = frame0_folder(root, tmp_path)
    listed = items_file(tmp_path / "items.txt", ["x1", "x3"], as_json=False)
    first_remap, first_out = tmp_path / "remap1.json", tmp_path / "out1.json"
    assert run(root, folder, "--items", str(listed), "--fix",
               "--remap", str(first_remap), "--out", str(first_out)) == 0
    assert list(json.loads(first_remap.read_text("utf-8"))) == ["x1", "x3"]
    after_first = contents(folder)

    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    steps = spy_file_steps(monkeypatch)
    remap, out = tmp_path / "remap2.json", tmp_path / "out2.json"
    assert run(root, folder, "--items", str(listed), "--fix",
               "--remap", str(remap), "--out", str(out)) == 0
    assert steps == []
    assert contents(folder) == after_first
    assert remap.read_bytes() == first_remap.read_bytes()
    assert out.read_bytes() == first_out.read_bytes()


# --- 8. luma on FAIL lines ---------------------------------------------------

FADE = {"source": {"path": "clips/fade.mp4"}, "kind": "video"}


def luma_fields(start: float, poster: float) -> str:
    return f", start luma {start:.1f}, poster luma {poster:.1f}"


def test_fail_lines_end_with_lumas_and_flag_a_dark_start(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    """A clip that fades in from black, its item starting at 0 with a
    poster made after the fade: a dark start next to a brighter poster.
    A frame-0 poster on a later start of a normal clip: lumas, no dark
    start. A poster that is not in the folder: no frame, so unknown."""
    _encode(root / "clips" / "fade.mp4", 7, "-vf", "fade=t=in:st=0:d=1",
            "-c:v", "libx264", "-pix_fmt", "yuv420p")
    folder = tmp_path / "folder"
    f0, f2, a0 = ship(root, folder, [FADE, at(FADE, 2.0), A])
    missing = "media/00/" + "0" * 64 + ".png"
    write_manifest(folder / "manifest.json", [
        dict(video("lead-in", f0), poster=f2["poster"]),
        video("late", a0, 1.0),
        dict(video("lost", a0, 1.0), poster=missing)])
    capsys.readouterr()

    assert run(root, folder) == 1

    found = fails(capsys.readouterr().out)
    assert sorted(found) == ["late", "lead-in", "lost"]

    dark = mean_luma(frame_image(root / "clips" / "fade.mp4", 0.0, tmp_path))
    bright = mean_luma(open_image(folder / f2["poster"]))
    assert dark < posters.DARK_START_LUMA < bright
    assert found["lead-in"].startswith(
        f"file {f0['file']}, startSeconds 0, poster startSeconds 2.0, "
        "difference ")
    assert found["lead-in"].endswith(
        "(ledger: poster made at another start)"
        + luma_fields(dark, bright) + ", dark start")

    start = mean_luma(frame_image(root / "clips" / "a.mp4", 1.0, tmp_path))
    poster = mean_luma(open_image(folder / a0["poster"]))
    assert start >= posters.DARK_START_LUMA
    assert found["late"].endswith("(ledger: poster made at another start)"
                                  + luma_fields(start, poster))

    assert "difference unknown (" in found["lost"]
    assert found["lost"].endswith(
        "), start luma unknown, poster luma unknown")


# --- 8. held videos' last frames (Phase 60 item 9n6) -------------------------

HA = dict(A, lastFrame=True)   # a's last frame ships too


def held(item_id: str, result: dict, last: str, start: float | None = None,
         end: float | None = None) -> dict:
    """A video item that holds its last frame, `last` its still."""
    item = dict(video(item_id, result, start), holdLastFrame=True,
                lastFrame=last)
    if end is not None:
        item["endSeconds"] = end
    return item


def last_summary(out: str) -> str:
    (line,) = [ln for ln in out.splitlines()
               if ln.startswith("last frames: ")]
    return line


def last_frame_pixels(video_path: Path, end: float | None, near: float,
                      tmp: Path) -> bytes:
    """The range's last frame as item 9n4's ship step takes it."""
    out = tmp / f"last-{video_path.stem}-{end}.png"
    assert assets.run_poster_step(assets.last_frame_step(end, near),
                                  video_path, out) is None
    return open_image(out).convert("RGB").tobytes()


def apply_last_frames(manifest: Path, remap: dict[str, str]) -> None:
    data = json.loads(manifest.read_text("utf-8"))
    for item in data["items"]:
        if item["id"] in remap:
            item["lastFrame"] = remap[item["id"]]
    manifest.write_text(json.dumps(data, indent=2), encoding="utf-8")


def held_folder(root: Path, tmp_path: Path) -> tuple[Path, Path, dict]:
    """`held` is right (by ledger), `pixels` right with a hand-made still
    the ledger does not hold. `both` starts at 1 s but has frame 0 as its
    poster and as its last frame. `ranged` ends at 2 s but has the
    file's last frame."""
    folder = tmp_path / "folder"
    (ha,) = ship(root, folder, [HA])
    a = root / "clips" / "a.mp4"
    copy = tmp_path / "copy.png"
    open_image(folder / ha["lastFrame"]).convert("RGB").save(
        copy, compress_level=0)
    by_hand = place(folder, copy.read_bytes(), "png")
    assert open_image(folder / by_hand).convert("RGB").tobytes() == \
        last_frame_pixels(a, None, 3.0, tmp_path)
    manifest = write_manifest(folder / "manifest.json", [
        held("held", ha, ha["lastFrame"]),
        held("both", ha, ha["poster"], start=1.0),
        held("pixels", ha, by_hand),
        held("ranged", ha, ha["lastFrame"], end=2.0)])
    return folder, manifest, ha


def test_held_videos_last_frames_are_checked(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, _, ha = held_folder(root, tmp_path)
    before = snapshot(tmp_path)
    capsys.readouterr()

    assert run(root, folder) == 1

    out = capsys.readouterr().out
    found = fails(out)
    assert sorted(found) == ["both", "both lastFrame", "ranged lastFrame"]
    assert found["both lastFrame"].startswith(
        f"file {ha['file']}, endSeconds file end, lastFrame "
        f"{ha['poster']}, lastFrame endSeconds none, difference ")
    assert "(pixels: the ledger records no lastFrame endSeconds, above " \
        "3.0), end luma " in found["both lastFrame"]
    assert found["ranged lastFrame"].startswith(
        f"file {ha['file']}, endSeconds 2.0, lastFrame {ha['lastFrame']}, "
        "lastFrame endSeconds file end, difference ")
    assert "(ledger: last frame made at another end)" in \
        found["ranged lastFrame"]
    for key in ("both lastFrame", "ranged lastFrame"):
        rest = found[key]
        difference = float(rest.split("difference ")[1].split(" ")[0])
        assert difference > posters.POSTER_TOLERANCE
        assert ", lastFrame luma " in rest
    assert summary(out) == ("posters: 4 video items: 4 checked, 3 passed "
                            "(3 by ledger, 0 by pixels), 1 failed, "
                            "0 skipped (first frame)")
    assert last_summary(out) == ("last frames: 4 held video items: "
                                 "4 checked, 2 passed (1 by ledger, 1 by "
                                 "pixels), 2 failed")
    assert snapshot(tmp_path) == before

    # --items limits the last frames too; a folder with no held video
    # prints no last-frame summary.
    listed = items_file(tmp_path / "held.json", ["held"])
    assert run(root, folder, "--items", str(listed)) == 0
    assert last_summary(capsys.readouterr().out) == (
        "last frames: 1 of 4 held video items selected: 1 checked, "
        "1 passed (1 by ledger, 0 by pixels), 0 failed")
    (tmp_path / "plain").mkdir()
    plain, _ = frame0_folder(root, tmp_path / "plain")
    run(root, plain)
    assert not any(ln.startswith("last frames: ")
                   for ln in capsys.readouterr().out.splitlines())


def test_wrong_last_frames_are_fixed_into_their_own_remap(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    """--fix ships one last frame per (video source, start, end) and
    writes item id -> new lastFrame to --last-frame-remap; --remap keeps
    its shape, item id -> new poster, posters only."""
    folder, manifest, ha = held_folder(root, tmp_path)
    remap_file = tmp_path / "remap.json"
    last_file = tmp_path / "last-frames.json"
    out_file = tmp_path / "requests.json"
    capsys.readouterr()

    assert run(root, folder, "--fix", "--remap", str(remap_file),
               "--last-frame-remap", str(last_file),
               "--out", str(out_file)) == 0

    out = capsys.readouterr().out
    assert "fix: 1 failing items, 2 failing last frames, 3 requests " \
        "shipped (one per video source and startSeconds, and per held " \
        "video's range end), 1 items remapped in " in out
    assert f"2 last frames remapped in {last_file}" in out
    assert json.loads(out_file.read_text("utf-8")) == [
        at(A, 1.0), dict(HA, startSeconds=1.0),
        dict(HA, endSeconds=2.0)]
    remap = json.loads(remap_file.read_text("utf-8"))
    assert list(remap) == ["both"]
    lasts = json.loads(last_file.read_text("utf-8"))
    assert list(lasts) == ["both", "ranged"]
    assert lasts["both"] == ha["lastFrame"]   # the file's own, reused
    a = root / "clips" / "a.mp4"
    assert open_image(folder / lasts["ranged"]).convert("RGB").tobytes() \
        == frame_pixels(a, 1.9, tmp_path)
    entry = ledger_of(folder)["media"][lasts["ranged"]]
    assert entry["kind"] == "lastFrame"
    assert entry["steps"][0]["endSeconds"] == 2.0

    # The caller applies both; the check then passes.
    apply_remap(manifest, remap)
    apply_last_frames(manifest, lasts)
    capsys.readouterr()
    assert run(root, folder) == 0
    assert last_summary(capsys.readouterr().out).endswith(
        "4 checked, 4 passed (3 by ledger, 1 by pixels), 0 failed")

    # A second fix of the same failures changes nothing.
    monkeypatch.setenv("KINETIC_MEDIA_CACHE", "off")
    held_manifest = write_manifest(tmp_path / "again" / "manifest.json", [
        held("both", ha, ha["poster"], start=1.0),
        held("ranged", ha, ha["lastFrame"], end=2.0)])
    after = contents(folder)
    steps = spy_file_steps(monkeypatch)
    last_again = tmp_path / "last-again.json"
    assert run(root, folder, "--manifest", str(held_manifest), "--fix",
               "--remap", str(tmp_path / "remap-again.json"),
               "--last-frame-remap", str(last_again)) == 0
    assert steps == []
    assert contents(folder) == after
    assert last_again.read_bytes() == last_file.read_bytes()


def test_a_last_frame_fix_needs_its_remap_file(
        root: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
        ) -> None:
    folder, _, ha = held_folder(root, tmp_path)
    remap = tmp_path / "remap.json"
    capsys.readouterr()
    assert run(root, folder, "--fix", "--remap", str(remap)) == 1
    out = capsys.readouterr().out
    unfixable = [ln for ln in out.splitlines()
                 if ln.startswith("NOT FIXABLE ")]
    assert [ln.split(":")[0] for ln in unfixable] == [
        "NOT FIXABLE both lastFrame", "NOT FIXABLE ranged lastFrame"]
    assert all("--last-frame-remap FILE" in ln for ln in unfixable)
    # The posters are still fixed; no last frame was shipped.
    assert list(json.loads(remap.read_text("utf-8"))) == ["both"]
    assert not any(step.get("endSeconds") == 2.0
                   for entry in ledger_of(folder)["media"].values()
                   for step in entry.get("steps", []))


def test_an_end_at_the_duration_is_the_file_s_end(
        root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
        capsys: pytest.CaptureFixture[str]) -> None:
    """A recorded file end (null) and an item `endSeconds` at its
    `durationSeconds` are the same last frame, and so are a recorded end
    at the duration and an item with no `endSeconds`: both pass by
    ledger, decoding nothing. A recorded end short of it still fails."""
    folder = tmp_path / "folder"
    (ha, again) = ship(root, folder, [HA, dict(HA, startSeconds=1.0)])
    duration = ha["durationSeconds"]
    assert again["lastFrame"] == ha["lastFrame"]
    # The same still recorded with its end at the duration instead (a
    # request that gave `endSeconds`; ship makes the same bytes).
    ledger = ledger_of(folder)
    for step in ledger["media"][ha["lastFrame"]]["steps"]:
        if step["step"] == "lastFrame":
            step["endSeconds"] = duration
    other = folder.parent / "other"
    other.mkdir()
    (other / LEDGER).write_text(json.dumps(ledger), encoding="utf-8")
    write_manifest(folder / "manifest.json", [
        held("ended", ha, ha["lastFrame"], end=duration),
        held("short", ha, ha["lastFrame"], end=duration - 0.5)])
    write_manifest(other / "manifest.json", [
        held("open", ha, ha["lastFrame"])])
    for ref in (ha["file"], ha["lastFrame"]):
        (other / ref).parent.mkdir(parents=True, exist_ok=True)
        (other / ref).write_bytes((folder / ref).read_bytes())
    calls = spy_ffmpeg(monkeypatch)
    capsys.readouterr()

    assert run(root, folder) == 1

    out = capsys.readouterr().out
    assert list(fails(out)) == ["short lastFrame"]
    assert "(ledger: last frame made at another end)" in \
        fails(out)["short lastFrame"]
    assert last_summary(out) == ("last frames: 2 held video items: "
                                 "2 checked, 1 passed (1 by ledger, 0 by "
                                 "pixels), 1 failed")
    # Only the failing one is decoded, for its report.
    assert len(calls) == 1

    assert run(root, other) == 0
    assert last_summary(capsys.readouterr().out) == (
        "last frames: 1 held video items: 1 checked, 1 passed (1 by "
        "ledger, 0 by pixels), 0 failed")
    assert len(calls) == 1
