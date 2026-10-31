#!/usr/bin/env python3
"""Generate fixtures/renpy_demo/game/data assets (tiny, deterministic).

Usage (from the repo root):

    .venv/bin/python fixtures/renpy_demo/generate_assets.py

PNGs are drawn with integer arithmetic in Pillow (no fonts, no RNG). The
mp4 is encoded from raw frames piped to ffmpeg with bitexact flags and
-threads 1, with no metadata or audio stream, so bytes and duration are
deterministic for a given ffmpeg build. ffmpeg must be on PATH.
"""

from __future__ import annotations

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


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    gradient("bg-room.png", (40, 60, 90), (10, 14, 24))
    gradient("bg-yard.png", (30, 90, 50), (8, 20, 12))
    clip()
    for path in sorted(DATA_DIR.iterdir()):
        print(f"{path.relative_to(DATA_DIR.parent.parent)}: "
              f"{path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
