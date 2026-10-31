#!/usr/bin/env python3
"""Generate fixtures/renpy_demo/game/data assets (tiny, deterministic).

Usage (from the repo root):

    .venv/bin/python fixtures/renpy_demo/generate_assets.py

PNGs are drawn with integer arithmetic in Pillow (no fonts). The photo-like
texture adds a dither from random.Random(fixed seed) - still fully
deterministic. The mp4 is encoded from raw frames piped to ffmpeg with
bitexact flags and -threads 1, with no metadata or audio stream, so bytes
and duration are deterministic for a given ffmpeg build. ffmpeg must be on
PATH.

Deliberate mislabels exercise content sniffing (docs/plan.md Phase 10:
corpus files lie): `mislabeled.png` holds BMP bytes and `mislabeled.jpg`
holds PNG bytes. `photo-noise.png` is a 256x256 photo-like texture where
lossless JPEG XL beats PNG; `anim.gif` is an animated image that must stay
byte-identical (never re-encoded).
"""

from __future__ import annotations

import math
import random
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

DATA_DIR = Path(__file__).resolve().parent / "game" / "data"
WIDTH, HEIGHT = 320, 180
FPS = 10
SECONDS = 1


def gradient(name: str, top: tuple[int, int, int],
             bottom: tuple[int, int, int]) -> None:
    img = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(img)
    for y in range(HEIGHT):
        r = (top[0] * (HEIGHT - y) + bottom[0] * y) // HEIGHT
        g = (top[1] * (HEIGHT - y) + bottom[1] * y) // HEIGHT
        b = (top[2] * (HEIGHT - y) + bottom[2] * y) // HEIGHT
        draw.line([(0, y), (WIDTH, y)], fill=(r, g, b))
    img.save(DATA_DIR / name, format="PNG", optimize=True)


def clip() -> None:
    frames = bytearray()
    for f in range(FPS * SECONDS):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                band = ((x * 8 // WIDTH) + f) % 8 < 4
                frames.extend((60 + 20 * f, 40, 120 + 30 * band)
                              if y % 3 else (30, 30, 90))
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo",
         "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS),
         "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt",
         "yuv420p", "-g", str(FPS), "-fflags", "+bitexact",
         "-flags", "+bitexact", "-map_metadata", "-1", "-an",
         "-threads", "1", "-movflags", "+faststart",
         str(DATA_DIR / "clip.mp4")],
        input=bytes(frames), check=True)


def mislabeled() -> None:
    """BMP bytes under a .png name; PNG bytes under a .jpg name."""
    img = Image.new("RGB", (48, 36))
    draw = ImageDraw.Draw(img)
    for y in range(36):
        draw.line([(0, y), (48, y)],
                  fill=(200 - 4 * y, 90 + 2 * y, 40 + 5 * y))
    img.save(DATA_DIR / "mislabeled.png", format="BMP")
    img.convert("P", palette=Image.ADAPTIVE, colors=24).save(
        DATA_DIR / "mislabeled.jpg", format="PNG", optimize=True)


def photo_noise() -> None:
    """256x256 photo-like texture: ring/sine/checker fields plus dither.

    The dither comes from random.Random(fixed seed). Lossless JXL beats
    PNG on this content by ~12 percent (about 107 KB vs 121 KB with
    cjxl -d 0); pure uniform noise would not, so the dither rides smooth
    channels rather than replacing them.
    """
    rnd = random.Random(20251101)
    size = 256
    data = bytearray()
    for y in range(size):
        for x in range(size):
            ring = 127 + 120 * (((x - 128) ** 2 + (y - 128) ** 2) ** 0.5
                                / 32 % 2)
            data += bytes([
                max(0, min(255, int(ring + 40 * math.sin(x / 17.3 + y / 9.1))
                           + rnd.randrange(-9, 10))),
                max(0, min(255, int(ring * 0.6
                                    + 60 * math.sin(x / 7.7 + y / 13.3))
                           + rnd.randrange(-9, 10))),
                max(0, min(255, int(127 + 90 * math.sin((x + y) / 11.7)
                                    + 30 * ((x // 32 + y // 32) % 2))
                           + rnd.randrange(-9, 10))),
            ])
    Image.frombytes("RGB", (size, size), bytes(data)).save(
        DATA_DIR / "photo-noise.png", format="PNG", optimize=True)


def tiny_gif() -> None:
    """Two-frame animated GIF: compatible AND animated => always preserved.

    Frames go through distinct RGB sources converted to P: two plain
    P-mode solids collapse to one frame in the GIF encoder.
    """
    f1 = Image.new("RGB", (16, 9), (220, 60, 40)).convert(
        "P", palette=Image.ADAPTIVE)
    f2 = Image.new("RGB", (16, 9), (40, 200, 90)).convert(
        "P", palette=Image.ADAPTIVE)
    f1.save(DATA_DIR / "anim.gif", save_all=True, append_images=[f2],
            duration=200, loop=0)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    gradient("bg-room.png", (40, 60, 90), (10, 14, 24))
    gradient("bg-yard.png", (30, 90, 50), (8, 20, 12))
    mislabeled()
    photo_noise()
    tiny_gif()
    clip()
    for path in sorted(DATA_DIR.iterdir()):
        print(f"{path.relative_to(DATA_DIR.parent.parent)}: "
              f"{path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
