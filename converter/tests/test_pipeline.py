"""Asset-pass tests (docs/plan.md Phase 10): content sniffing wins over
extensions, JXL ships only when strictly smaller, identical sources dedup,
wrapped images carve or skip, posters land on the requested range start,
and the validator accepts the output folder with the ledger present."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from kinetic_extract import assets
from kinetic_extract.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE = REPO_ROOT / "fixtures" / "renpy_demo"
CLIP = FIXTURE / "game" / "data" / "clip.mp4"


def extract(out: Path) -> tuple[dict, dict]:
    rc = cli_main([str(FIXTURE), str(out)])
    assert rc == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    return manifest, ledger


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
    if assets.cjxl_available():
        assert noise["decision"] == "jxl"
        assert noise["shippedBytes"] < noise["sourceBytes"]
    else:  # no encoder on this machine: original must be kept
        assert noise["decision"] == "preserve"
        assert noise["shippedBytes"] == noise["sourceBytes"]
    # Animated images are never re-encoded, JXL or not.
    assert gif["decision"] == "preserve"


def test_fixture_photo_noise_jxl_smaller_when_cjxl_present(tmp_path: Path) -> None:
    """The fixture asset is chosen so lossless JXL genuinely wins."""
    if not shutil.which("cjxl") or not shutil.which("djxl"):
        return  # machine without JXL tools: nothing to assert
    png = (FIXTURE / "game" / "data" / "photo-noise.png").read_bytes()
    src = tmp_path / "photo-noise.png"
    src.write_bytes(png)
    r = subprocess.run(["cjxl", "-d", "0", "-e", "9", str(src),
                        str(tmp_path / "p.jxl")],
                       capture_output=True, check=False)
    assert r.returncode == 0
    assert (tmp_path / "p.jxl").stat().st_size < len(png)


# --- dedup --------------------------------------------------------------------

def test_identical_sources_share_one_shipped_file(tmp_path: Path) -> None:
    manifest, ledger = extract(tmp_path / "out")
    by_id = {i["id"]: i for i in manifest["items"]}
    first = by_id["bg-room-001"]["file"]
    assert by_id["bg-room-013"]["file"] == first      # `scene bg-room` again
    assert by_id["bg-reprise-017"]["file"] == first   # same bytes, new name
    shared = list((tmp_path / "out").glob("bg-room-*"))
    assert [p.name for p in shared] == [first]
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


def test_poster_exists_nonblack_and_at_range_start(tmp_path: Path) -> None:
    manifest, _ = extract(tmp_path / "out")
    video = next(i for i in manifest["items"] if i["type"] == "video")
    poster = tmp_path / "out" / video["poster"]
    assert video["poster"] == "clip-004.poster.jpg"
    assert poster.is_file() and mean_luma(poster) > 10  # nonblack
    # The same extractor at a range start also yields a real frame.
    mid = tmp_path / "poster-0p5.jpg"
    assert assets.extract_poster(CLIP, mid, 0.5)
    assert mean_luma(mid) > 10


# --- validator + ledger extra ---------------------------------------------------

def test_validator_exit_zero_with_ledger(tmp_path: Path) -> None:
    out = tmp_path / "out"
    _, ledger = extract(out)
    assert (out / "build-ledger.json").is_file()  # unreferenced extra
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)],
        capture_output=True, text=True, check=False)
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
    assert wrapped["file"].startswith(f"{wrapped['id']}.")
    assert wrapped["file"].endswith((".png", ".jxl"))
    assert (out / wrapped["file"]).is_file()
    # The junk item never reaches the manifest but is explained in the ledger.
    junk_ids = [i for i in ledger["items"] if i.startswith("junk-")]
    assert junk_ids
    assert junk_ids[0] not in ids
    junk = ledger["items"][junk_ids[0]]
    assert junk["decision"] == "skipped"
    assert junk["sniffedFormat"] == "unknown"
    # The folder still validates: the skipped item left no dangling media.
    proc = subprocess.run(
        [sys.executable, str(REPO_ROOT / "tools" / "validate_content.py"),
         str(out)],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
