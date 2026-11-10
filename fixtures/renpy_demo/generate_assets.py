#!/usr/bin/env python3
"""Generate fixtures/renpy_demo/game/data assets (tiny, deterministic).

Usage (from the repo root):

    .venv/bin/python fixtures/renpy_demo/generate_assets.py

PNGs are drawn with integer arithmetic in Pillow (no fonts). The photo-like
texture adds a dither from random.Random(fixed seed) - still fully
deterministic. The mp4s are encoded from raw frames piped to ffmpeg with
bitexact flags and -threads 1 and no metadata, so bytes and duration are
deterministic for a given ffmpeg build: `clip.mp4` has no audio stream
(`-an`), `talk.mp4` has an audible MP3 soundtrack. ffmpeg must be on PATH.

The sound (docs/plan.md Phase 47, item 9) is one mono file per role, each
a distinct tone made by ffmpeg's lavfi sources: music `audio/theme.mp3`
(440 Hz, 2 s), the ambience loop `audio/rain.webm` (Vorbis pink noise,
1 s), the one-shot `audio/door.wav` (880 Hz, 0.3 s, 8-bit PCM), the voice
line `voice/viktor-01.mp3` (330 Hz, 1.5 s) and the movie's soundtrack
(660 Hz). Every format here ships byte-identical, and the movie's MP3
stream is copied out as raw frames, so the converted bytes and decoded
durations do not depend on the converter's ffmpeg version.

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

GAME_DIR = Path(__file__).resolve().parent / "game"
DATA_DIR = GAME_DIR / "data"
WIDTH, HEIGHT = 320, 180
FPS = 10
SECONDS = 1
RATE = 22050
MP3 = ["-c:a", "libmp3lame", "-b:a", "24k"]
BITEXACT = ["-fflags", "+bitexact", "-flags", "+bitexact",
            "-map_metadata", "-1"]


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


def movie(name: str, frames: bytes, sound: list[str]) -> None:
    """H.264 MP4 from raw RGB frames; `sound` adds the audio input and
    codec, or is ``["-an"]``."""
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo",
         "-pix_fmt", "rgb24", "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS),
         "-i", "-", *sound, "-c:v", "libx264", "-preset", "veryfast",
         "-pix_fmt", "yuv420p", "-g", str(FPS), *BITEXACT,
         "-threads", "1", "-movflags", "+faststart",
         str(DATA_DIR / name)],
        input=frames, check=True)


def clip() -> None:
    frames = bytearray()
    for f in range(FPS * SECONDS):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                band = ((x * 8 // WIDTH) + f) % 8 < 4
                frames.extend((60 + 20 * f, 40, 120 + 30 * band)
                              if y % 3 else (30, 30, 90))
    movie("clip.mp4", bytes(frames), ["-an"])


def talk() -> None:
    """A warm striped picture with a 660 Hz soundtrack, cut to the
    picture's 1 s (``-shortest``)."""
    frames = bytearray()
    for f in range(FPS * SECONDS):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                band = ((x * 8 // WIDTH) + f) % 8 < 4
                frames.extend((200 - 10 * f, 120, 40 + 60 * band)
                              if y % 4 else (90, 40, 20))
    movie("talk.mp4", bytes(frames),
          ["-f", "lavfi", "-i", f"sine=frequency=660:sample_rate={RATE}"
           ":duration=1.2", "-map", "0:v", "-map", "1:a", *MP3, "-ac", "1",
           "-shortest"])


def tone(rel: str, source: str, codec: list[str]) -> None:
    """A mono audio file under game/ from an ffmpeg lavfi `source`."""
    out = GAME_DIR / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", source,
         "-ac", "1", *codec, *BITEXACT, "-threads", "1", str(out)],
        check=True)


def sounds() -> None:
    tone("audio/theme.mp3",
         f"sine=frequency=440:sample_rate={RATE}:duration=2", MP3)
    tone("audio/rain.webm",
         "anoisesrc=color=pink:amplitude=0.1:sample_rate=11025:duration=1"
         ":seed=7", ["-c:a", "libvorbis", "-q:a", "0"])
    tone("audio/door.wav",
         "sine=frequency=880:sample_rate=11025:duration=0.3",
         ["-c:a", "pcm_u8"])
    tone("voice/viktor-01.mp3",
         f"sine=frequency=330:sample_rate={RATE}:duration=1.5", MP3)


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
    talk()
    sounds()
    for path in sorted(p for p in GAME_DIR.rglob("*")
                       if p.is_file() and p.suffix != ".rpy"):
        print(f"{path.relative_to(GAME_DIR.parent)}: "
              f"{path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
