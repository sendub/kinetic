"""Asset-pass tests (docs/plan.md Phase 10, Phase 17): content sniffing wins
over extensions, JXL ships only when strictly smaller, identical sources
dedup, wrapped images carve or skip, posters land on the requested range
start, every shipped file is named by the sha256 of its own bytes under
``media/<h[:2]>/`` (Phase 25), two runs are byte-identical, and the
validator accepts the output folder with the ledger present."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import pytest
from helpers import content_ref, declared_media, is_content_addressed
from kinetic_extract import assets, media_tools
from kinetic_extract.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
CLIP = FIXTURE / "game" / "data" / "clip.mp4"
FOLDER_FILES = {"manifest.json", "manifest.js", "build-ledger.json"}


def extract(out: Path) -> tuple[dict, dict]:
    rc = cli_main([str(FIXTURE), str(out)])
    assert rc == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return manifest, ledger


def run_validator(out: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)],
        capture_output=True, text=True, check=False)


def mean_luma(path: Path) -> float:
    from PIL import Image

    with Image.open(path) as img:
        gray = img.convert("L")
        hist = gray.histogram()
        pixels = gray.size[0] * gray.size[1]
    return sum(v * count for v, count in enumerate(hist)) / pixels


# --- sniffing beats the extension ------------------------------------------

def test_mislabeled_assets_sniffed_to_true_format(tmp_path: Path) -> None:
    _, ledger = extract(tmp_path / "out")
    bmp = ledger["items"]["mislabel-bmp-015"]   # source name *.png
    png = ledger["items"]["mislabel-png-016"]   # source name *.jpg
    assert bmp["sniffedFormat"] == "bmp"
    assert bmp["decision"] == "decode-convert"
    assert png["sniffedFormat"] == "png"
    # Shipped names carry the TRUE format, never the lying source ext.
    assert not png["shippedFile"].endswith(".jpg")
    assert (tmp_path / "out" / png["shippedFile"]).read_bytes()[:8] \
        == b"\x89PNG\r\n\x1a\n" or png["shippedFile"].endswith(".jxl")


def test_sniff_image_direct() -> None:
    gif = (FIXTURE / "game" / "data" / "anim.gif").read_bytes()
    assert assets.sniff_image(gif) == ("gif", 0)
    png = (FIXTURE / "game" / "data" / "bg-room.png").read_bytes()
    assert assets.sniff_image(b"\x00\x11\x22\xfe\xff" + png) == ("png", 5)
    assert assets.sniff_image(b"NO-SIGNATURE-HERE" * 4) == (None, 0)
    assert assets.is_animated(gif, "gif") is True
    assert assets.is_animated(png, "png") is False


# --- JXL smaller-only rule ---------------------------------------------------

def test_jxl_smaller_rule_recorded(tmp_path: Path) -> None:
    _, ledger = extract(tmp_path / "out")
    noise = ledger["items"]["photo-noise-018"]
    gif = ledger["items"]["bg-gif-019"]
    # libjxl is a pinned dependency (imagecodecs): always available.
    assert assets.jxl_available()
    assert noise["decision"] == "jxl"
    assert noise["shippedBytes"] < noise["sourceBytes"]
    # Animated images are never re-encoded, JXL or not.
    assert gif["decision"] == "preserve"


def test_fixture_photo_noise_jxl_smaller() -> None:
    """The fixture asset is chosen so lossless JXL genuinely wins, and the
    shipped JXL decodes back to the source pixels."""
    from PIL import Image

    png = (FIXTURE / "game" / "data" / "photo-noise.png").read_bytes()
    jxl = assets._encode_jxl_lossless(png, "png")
    assert jxl is not None and len(jxl) < len(png)
    with Image.open(BytesIO(png)) as orig:
        back = Image.fromarray(media_tools.jxl_decode(jxl))
        assert back.convert("RGBA").tobytes() == orig.convert("RGBA").tobytes()


def test_webp_never_becomes_jxl_yet() -> None:
    """WebP waits for docs/plan.md 25.5 (cjxl never read it either)."""
    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (32, 32), (10, 200, 30)).save(buf, "WEBP", lossless=True)
    ext, out, decision, _ = assets.decide_image_ship(buf.getvalue(), "webp",
                                                     False)
    assert (ext, decision) == ("webp", "preserve")
    assert out == buf.getvalue()


# --- dedup --------------------------------------------------------------------

def test_identical_sources_share_one_shipped_file(tmp_path: Path) -> None:
    manifest, ledger = extract(tmp_path / "out")
    by_id = {i["id"]: i for i in manifest["items"]}
    first = by_id["bg-room-001"]["file"]
    assert by_id["bg-room-013"]["file"] == first      # `scene bg-room` again
    assert by_id["bg-reprise-017"]["file"] == first   # same bytes, new name
    out = tmp_path / "out"
    data = (out / first).read_bytes()
    copies = [p.relative_to(out).as_posix() for p in out.rglob("*")
              if p.is_file() and p.read_bytes() == data]
    assert copies == [first]                          # written once
    assert ledger["items"]["bg-reprise-017"]["dedupOf"] == first


# --- video policy and posters --------------------------------------------------

def test_native_video_copied_with_codec_recorded(tmp_path: Path) -> None:
    manifest, ledger = extract(tmp_path / "out")
    entry = ledger["items"]["clip-004"]
    video = next(i for i in manifest["items"] if i["type"] == "video")
    assert entry["decision"] == "copy"
    assert entry["codec"] == "h264"
    assert entry["sniffedFormat"] == "mp4"
    assert entry["shippedBytes"] == entry["sourceBytes"]
    shipped = tmp_path / "out" / video["file"]
    assert shipped.read_bytes() == CLIP.read_bytes()
    assert video["file"] == content_ref(CLIP.read_bytes(), "mp4")


def test_poster_exists_nonblack_and_at_range_start(tmp_path: Path) -> None:
    manifest, _ = extract(tmp_path / "out")
    video = next(i for i in manifest["items"] if i["type"] == "video")
    poster = tmp_path / "out" / video["poster"]
    assert is_content_addressed(tmp_path / "out", video["poster"])
    assert video["poster"].endswith(".jpg")
    assert poster.is_file() and mean_luma(poster) > 10  # nonblack
    # The same extractor at a range start also yields a real frame.
    mid = tmp_path / "poster-0p5.jpg"
    assert assets.extract_poster(CLIP, mid, 0.5)
    assert mean_luma(mid) > 10


# --- output layout: content-addressed media (docs/plan.md Phase 25) -----------

def test_every_declared_path_is_the_sha256_of_its_bytes(tmp_path: Path) -> None:
    """Each media path == media/<h[:2]>/<h>.<ext>, h = sha256(shipped bytes)."""
    out = tmp_path / "out"
    manifest, ledger = extract(out)
    declared = declared_media(manifest)
    assert declared, "the fixture ships no media"
    for ref in declared:
        assert is_content_addressed(out, ref), ref
    # Nothing shipped sits outside media/: the folder holds nothing but the
    # three folder files plus media/<xx>/<sha256>.<ext>, and no assets/.
    on_disk = [p.relative_to(out).as_posix() for p in out.rglob("*")
               if p.is_file() and p.name not in FOLDER_FILES]
    assert all(len(ref.split("/")) == 3 and ref.startswith("media/")
               for ref in on_disk), on_disk
    assert set(on_disk) == set(declared)
    assert not (out / "assets").exists()
    assert "assets/" not in (out / "manifest.json").read_text("utf-8")
    assert "assets/" not in (out / "build-ledger.json").read_text("utf-8")
    # The ledger names the same paths the manifest does: no drift.
    for entry in ledger["items"].values():
        for key in ("shippedFile", "shippedPoster", "dedupOf"):
            if entry.get(key):
                assert entry[key] in declared


def test_identical_shipped_bytes_share_one_path(tmp_path: Path) -> None:
    """Different SOURCES that ship the same bytes land on one path, written
    once: a plain PNG and the same PNG carved out of a wrapped file."""
    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (24, 16), (9, 200, 40)).save(buf, "PNG")
    project = _make_project(tmp_path, buf.getvalue(), buf.getvalue())
    out = tmp_path / "out"
    assert cli_main([str(project), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    by_prefix = {i["id"].split("-")[0]: i for i in manifest["items"]}
    good, wrapped = by_prefix["good"]["file"], by_prefix["wrapped"]["file"]
    assert good == wrapped
    assert is_content_addressed(out, good)
    shipped = [p for p in out.rglob("*")
               if p.is_file() and p.name not in FOLDER_FILES]
    assert [p.relative_to(out).as_posix() for p in shipped] == [good]


def test_sha256_file_streams_in_chunks(tmp_path: Path) -> None:
    """The file hash matches hashlib over the whole bytes, read in chunks
    (a big video is never read whole just to name it)."""
    big = tmp_path / "big.bin"
    data = bytes(range(256)) * 9000          # > one chunk
    big.write_bytes(data)
    assert assets.sha256_file(big, chunk=4096) == hashlib.sha256(data).hexdigest()


def test_flat_option_is_gone(tmp_path: Path) -> None:
    """One fixed layout: --flat no longer exists."""
    with pytest.raises(SystemExit) as exc:
        cli_main([str(FIXTURE), str(tmp_path / "out"), "--flat"])
    assert exc.value.code == 2


def test_two_runs_are_byte_identical(tmp_path: Path) -> None:
    """Same input -> identical manifest, ledger, paths, and media bytes."""
    left, right = tmp_path / "left", tmp_path / "right"
    extract(left)
    extract(right)
    for name in ("manifest.json", "manifest.js", "build-ledger.json"):
        assert (left / name).read_bytes() == (right / name).read_bytes(), name
    left_files = sorted(p.relative_to(left).as_posix()
                        for p in left.rglob("*") if p.is_file())
    right_files = sorted(p.relative_to(right).as_posix()
                         for p in right.rglob("*") if p.is_file())
    assert left_files == right_files       # same files, same paths
    for rel in left_files:
        assert (left / rel).read_bytes() == (right / rel).read_bytes(), rel


# --- validator + ledger extra ---------------------------------------------------

def test_validator_exit_zero_with_ledger(tmp_path: Path) -> None:
    out = tmp_path / "out"
    _, ledger = extract(out)
    assert (out / "build-ledger.json").is_file()  # unreferenced extra
    proc = run_validator(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    # The ledger carries the per-item asset facts the plan requires.
    for entry in ledger["items"].values():
        if entry.get("asset"):
            assert {"sniffedFormat", "decision", "sourceBytes"} <= set(entry)


# --- wrapped / unsupported images -----------------------------------------------

def _make_project(tmp: Path, good_png: bytes, wrapped_png: bytes) -> Path:
    game = tmp / "proj" / "game"
    (game / "data").mkdir(parents=True)
    (game / "data" / "good.png").write_bytes(good_png)
    (game / "data" / "wrapped.bin").write_bytes(b"\x00\x11\x22\xfe\xff"
                                                + wrapped_png)
    (game / "data" / "junk.bin").write_bytes(b"RENPY-WRAPPED-IMAGE" * 8)
    (game / "script.rpy").write_text(
        'image good "data/good.png"\n'
        'image wrapped "data/wrapped.bin"\n'
        'image junk "data/junk.bin"\n'
        'label start:\n'
        '    scene good\n'
        '    "First a real image."\n'
        '    show wrapped\n'
        '    "Carved out of a wrapped file."\n'
        '    show junk\n'
        '    "An unreadable image, then one more line."\n',
        encoding="utf-8")
    return tmp / "proj"


def test_wrapped_image_carved_and_unsupported_item_skipped(
        tmp_path: Path) -> None:
    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (24, 16), (9, 200, 40)).save(buf, "PNG")
    buf2 = BytesIO()
    Image.new("RGB", (20, 12), (200, 9, 40)).save(buf2, "PNG")
    project = _make_project(tmp_path, buf.getvalue(), buf2.getvalue())
    out = tmp_path / "out"
    assert cli_main([str(project), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    ids = [i["id"] for i in manifest["items"]]
    wrapped = next(i for i in manifest["items"] if i["id"]
                   .startswith("wrapped-"))
    entry = ledger["items"][wrapped["id"]]
    assert entry["decision"] == "carved"
    assert entry["wrapped"] == 5
    assert wrapped["file"].endswith((".png", ".jxl"))
    assert is_content_addressed(out, wrapped["file"])
    # The junk item never reaches the manifest but is explained in the ledger.
    junk_ids = [i for i in ledger["items"] if i.startswith("junk-")]
    assert junk_ids
    assert junk_ids[0] not in ids
    junk = ledger["items"][junk_ids[0]]
    assert junk["decision"] == "skipped"
    assert junk["sniffedFormat"] == "unknown"
    # The folder still validates: the skipped item left no dangling media.
    proc = run_validator(out)
    assert proc.returncode == 0, proc.stdout + proc.stderr
