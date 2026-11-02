"""Image ship policy (docs/plan.md Phase 25, item 25.5).

Lossless JPEG XL ships only when strictly smaller than the original and
verified: pixel formats (PNG, GIF, WebP) decode to pixels, encode
lossless and must decode back to identical pixels; JPEG uses JPEG XL
recompression and must reconstruct the original JPEG bytes exactly.
Animated images and anything not representable exactly keep their
original bytes, with the reason on the ledger's ``preserve`` step.
``.jxl`` sources ship as they are.
"""

from __future__ import annotations

import json
import struct
import zlib
from io import BytesIO
from pathlib import Path

import numpy
import pytest
from PIL import Image, ImageCms

from kinetic_extract import assets, media_tools
from kinetic_extract.cli import main as cli_main

REPO_ROOT = Path(__file__).resolve().parents[2]
NOISE_PNG = REPO_ROOT / "fixtures" / "renpy_demo" / "game" / "data" \
    / "photo-noise.png"

PIXEL_STEP = {"step": "jxl", "mode": "lossless",
              "effort": media_tools.JXL_EFFORT, "threads": 1,
              "verify": "pixels-identical"}
JPEG_STEP = {"step": "jxl", "mode": "jpeg-recompression", "threads": 1,
             "verify": "jpeg-bytes-identical"}


def noise() -> Image.Image:
    """A photo-like image on which lossless JXL beats PNG and WebP."""
    with Image.open(NOISE_PNG) as img:
        img.load()
        return img.copy()


def save(img: Image.Image, fmt: str, **params) -> bytes:
    buf = BytesIO()
    img.save(buf, fmt, **params)
    return buf.getvalue()


def ship(data: bytes, fmt: str):
    return assets.decide_image_ship(data, fmt, False)


def rgba(img: Image.Image) -> bytes:
    return img.convert("RGBA").tobytes()


def decoded(jxl: bytes) -> Image.Image:
    return Image.fromarray(media_tools.jxl_decode(jxl))


def source_rgba(data: bytes) -> bytes:
    with Image.open(BytesIO(data)) as img:
        return rgba(img)


def kept(result, data: bytes, ext: str, reason: str) -> None:
    out_ext, out, decision, notes, steps = result
    assert (out_ext, decision) == (ext, "preserve")
    assert out == data
    (step,) = steps
    assert step["step"] == "preserve"
    assert reason in step["reason"]
    assert any(reason in note for note in notes)


# --- WebP ---------------------------------------------------------------------

def test_lossless_webp_ships_verified_lossless_jxl() -> None:
    data = save(noise(), "WEBP", lossless=True, quality=0, method=0)
    ext, out, decision, notes, steps = ship(data, "webp")
    assert (ext, decision) == ("jxl", "jxl")
    assert steps == [{**PIXEL_STEP, "pixels": "RGB"}]
    assert len(out) < len(data)
    assert rgba(decoded(out)) == source_rgba(data)
    assert any(f"< original {len(data)}" in note for note in notes)


def test_lossy_webp_keeps_original_when_jxl_is_bigger() -> None:
    data = save(noise(), "WEBP", quality=50)
    candidate = assets.jxl_candidate(data, "webp")
    # The lossless encode of the decoded pixels is exact, just bigger.
    assert candidate.out is not None
    assert rgba(decoded(candidate.out)) == source_rgba(data)
    assert len(candidate.out) >= len(data)
    kept(ship(data, "webp"), data, "webp",
         f"jxl {len(candidate.out)} >= original {len(data)}")


def test_webp_alpha_round_trips() -> None:
    img = noise().convert("RGBA")
    img.putalpha(Image.linear_gradient("L").resize(img.size))
    data = save(img, "WEBP", lossless=True, quality=0, method=0)
    candidate = assets.jxl_candidate(data, "webp")
    assert candidate.out is not None
    assert candidate.step == {**PIXEL_STEP, "pixels": "RGBA"}
    assert rgba(decoded(candidate.out)) == source_rgba(data)


def test_exif_orientation_on_pixel_source_keeps_original() -> None:
    exif = Image.Exif()
    exif[0x0112] = 6
    data = save(noise(), "WEBP", lossless=True, quality=0, method=0,
                exif=exif.tobytes())
    kept(ship(data, "webp"), data, "webp", "EXIF orientation 6")


# --- JPEG ---------------------------------------------------------------------

def test_jpeg_ships_recompression_that_reconstructs_exact_bytes() -> None:
    data = save(noise(), "JPEG", quality=90)
    ext, out, decision, _, steps = ship(data, "jpeg")
    assert (ext, decision) == ("jxl", "jxl")
    assert steps == [JPEG_STEP]
    assert len(out) < len(data)
    assert media_tools.jxl_reconstruct_jpeg(out) == data


def test_jpeg_whose_reconstruction_differs_keeps_original(
        monkeypatch: pytest.MonkeyPatch) -> None:
    data = save(noise(), "JPEG", quality=90)
    monkeypatch.setattr(media_tools, "jxl_reconstruct_jpeg",
                        lambda jxl: data[:-1] + b"\x00")
    kept(ship(data, "jpeg"), data, "jpg",
         "jpeg reconstruction differs from the original bytes")


def test_jpeg_recompression_failure_keeps_original() -> None:
    """libjxl cannot recompress a CMYK JPEG; the original ships."""
    data = save(noise().convert("CMYK"), "JPEG", quality=90)
    kept(ship(data, "jpeg"), data, "jpg", "jpeg recompression failed")


# --- PNG / GIF modes ------------------------------------------------------------

def _palette(transparent: bool) -> Image.Image:
    img = noise().quantize(64)
    if transparent:
        img.info["transparency"] = 0
    return img


@pytest.mark.parametrize("name,make,pixels", [
    ("rgb", lambda: noise(), "RGB"),
    ("rgba", lambda: noise().convert("RGBA"), "RGBA"),
    ("l", lambda: noise().convert("L"), "L"),
    ("la", lambda: noise().convert("LA"), "LA"),
    ("bilevel", lambda: noise().convert("1"), "L"),
    ("palette", lambda: _palette(False), "RGB"),
    ("palette-alpha", lambda: _palette(True), "RGBA"),
])
def test_png_modes_encode_exactly(name, make, pixels) -> None:
    img = make()
    if name == "rgba":
        img.putalpha(Image.linear_gradient("L").resize(img.size))
    if name == "la":
        img.putalpha(Image.linear_gradient("L").resize(img.size))
    data = save(img, "PNG")
    candidate = assets.jxl_candidate(data, "png")
    assert candidate.out is not None, candidate.reason
    assert candidate.step == {**PIXEL_STEP, "pixels": pixels}
    assert rgba(decoded(candidate.out)) == source_rgba(data)


def test_png_noise_ships_jxl_with_verify_step() -> None:
    data = NOISE_PNG.read_bytes()
    ext, out, decision, _, steps = ship(data, "png")
    assert (ext, decision) == ("jxl", "jxl")
    assert steps == [{**PIXEL_STEP, "pixels": "RGB"}]
    assert rgba(decoded(out)) == source_rgba(data)


def test_single_frame_gif_palette_round_trips() -> None:
    data = save(_palette(True), "GIF")
    candidate = assets.jxl_candidate(data, "gif")
    assert candidate.out is not None, candidate.reason
    assert candidate.step["pixels"] == "RGBA"
    assert rgba(decoded(candidate.out)) == source_rgba(data)


def _png_chunk(kind: bytes, body: bytes) -> bytes:
    return (struct.pack(">I", len(body)) + kind + body
            + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))


def _png16_rgb(width: int = 8, height: int = 4) -> bytes:
    """A 16-bit-per-channel RGB PNG (Pillow reads it as 8-bit RGB)."""
    rows = b"".join(
        b"\x00" + b"".join(struct.pack(">HHH", x * 4097, y * 9001, 513)
                           for x in range(width))
        for y in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height,
                                              16, 2, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress(rows))
            + _png_chunk(b"IEND", b""))


def test_16_bit_png_keeps_original() -> None:
    data = _png16_rgb()
    with Image.open(BytesIO(data)) as img:
        assert img.mode == "RGB"  # the 16-bit depth is invisible here
    kept(ship(data, "png"), data, "png", "16-bit PNG")


def test_16_bit_grayscale_png_keeps_original() -> None:
    img = Image.fromarray(numpy.arange(64, dtype=numpy.uint16)
                          .reshape(8, 8) * 1000)
    data = save(img, "PNG")
    kept(ship(data, "png"), data, "png", "16-bit PNG")


def test_non_srgb_icc_profile_keeps_original() -> None:
    """Pixels encode without the profile, which would change the colours a
    colour-managed browser shows."""
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("LAB"))
    data = save(noise(), "PNG", icc_profile=profile.tobytes())
    kept(ship(data, "png"), data, "png",
         "embedded ICC profile is not sRGB for these pixels")


def test_srgb_icc_profile_is_dropped_and_recorded() -> None:
    """An embedded sRGB profile (common: GIMP's built-in sRGB) maps the
    pixels to sRGB unchanged, so the untagged JXL shows the same colours."""
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
    data = save(noise(), "PNG", icc_profile=profile.tobytes())
    ext, out, decision, _, steps = ship(data, "png")
    assert (ext, decision) == ("jxl", "jxl")
    assert steps == [{**PIXEL_STEP, "pixels": "RGB", "iccProfile":
                      "dropped: maps these pixels to sRGB unchanged"}]
    assert rgba(decoded(out)) == source_rgba(data)


# --- smaller-only rule ----------------------------------------------------------

def test_equal_size_jxl_keeps_original(
        monkeypatch: pytest.MonkeyPatch) -> None:
    data = NOISE_PNG.read_bytes()
    with Image.open(NOISE_PNG) as img:
        pixels = numpy.asarray(img.convert("RGB"))
    monkeypatch.setattr(media_tools, "jxl_encode_lossless",
                        lambda _px: b"J" * len(data))
    monkeypatch.setattr(media_tools, "jxl_decode", lambda _d: pixels)
    kept(ship(data, "png"), data, "png",
         f"jxl {len(data)} >= original {len(data)}")


def test_pixel_mismatch_keeps_original(
        monkeypatch: pytest.MonkeyPatch) -> None:
    data = NOISE_PNG.read_bytes()
    with Image.open(NOISE_PNG) as img:
        pixels = numpy.asarray(img.convert("RGB")).copy()
    pixels[0, 0, 0] ^= 1
    monkeypatch.setattr(media_tools, "jxl_decode", lambda _d: pixels)
    kept(ship(data, "png"), data, "png", "decoded JXL pixels differ")


# --- animation ------------------------------------------------------------------

def _frames() -> list[Image.Image]:
    return [Image.new("RGB", (16, 16), color)
            for color in ((200, 10, 10), (10, 200, 10), (10, 10, 200))]


@pytest.mark.parametrize("fmt,ext,params", [
    ("GIF", "gif", {}),
    ("WEBP", "webp", {"lossless": True}),
    ("PNG", "png", {}),
])
def test_animated_images_keep_original_bytes(fmt, ext, params) -> None:
    first, *rest = _frames()
    data = save(first, fmt, save_all=True, append_images=rest,
                duration=[100, 250, 400], loop=0, **params)
    sniffed = "png" if fmt == "PNG" else ext
    assert assets.is_animated(data, sniffed)
    kept(ship(data, sniffed), data, ext, "animated")


# --- .jxl sources ---------------------------------------------------------------

def _jxl_source() -> bytes:
    return media_tools.jxl_encode_lossless(numpy.asarray(noise()))


def test_jxl_source_sniffs_and_ships_unchanged() -> None:
    data = _jxl_source()
    assert assets.sniff_image(data) == ("jxl", 0)
    ext, out, decision, _, steps = ship(data, "jxl")
    assert (ext, out, decision) == ("jxl", data, "preserve")
    assert steps == [{"step": "preserve"}]


def _project(tmp: Path, files: dict[str, bytes]) -> Path:
    game = tmp / "proj" / "game"
    for rel, data in files.items():
        (game / rel).parent.mkdir(parents=True, exist_ok=True)
        (game / rel).write_bytes(data)
    script = "".join(f'image {Path(rel).stem} "{rel}"\n' for rel in files)
    script += "label start:\n" + "".join(
        f'    scene {Path(rel).stem}\n    "line {i}"\n'
        for i, rel in enumerate(files))
    (game / "script.rpy").write_text(script, encoding="utf-8")
    return game.parent


def test_jxl_source_ships_through_the_extractor(tmp_path: Path,
                                                monkeypatch) -> None:
    monkeypatch.setenv("KINETIC_EXTRACT_CACHE", str(tmp_path / "cache"))
    data = _jxl_source()
    broken = b"\xff\x0a\xfa" + b"\x00" * 40  # JXL magic, no image
    project = _project(tmp_path, {"data/good.jxl": data,
                                  "data/broken.jxl": broken})
    out = tmp_path / "out"
    assert cli_main([str(project), str(out)]) == 0
    manifest = json.loads((out / "manifest.json").read_text("utf-8"))
    ledger = json.loads((out / "build-ledger.json").read_text("utf-8"))
    good = next(i for i in ledger["items"] if i.startswith("good-"))
    entry = ledger["items"][good]
    assert (entry["sniffedFormat"], entry["decision"]) == ("jxl", "preserve")
    assert entry["file"].endswith(".jxl")
    assert (out / entry["file"]).read_bytes() == data
    assert ledger["media"][entry["file"]]["steps"] == [{"step": "preserve"}]
    broken_id = next(i for i in ledger["items"] if i.startswith("broken-"))
    assert ledger["items"][broken_id]["decision"] == "skipped"
    assert broken_id not in {i["id"] for i in manifest["items"]}
    # The jxl source's pixel size counts towards the folder resolution.
    assert (manifest["width"], manifest["height"]) == noise().size
