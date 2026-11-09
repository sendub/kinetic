#!/usr/bin/env python3
"""Generate fixtures/demo: the Kinetic feature demo content folder.

Usage (from the repo root, Pillow and jsonschema live in the repo venv):

    .venv/bin/python fixtures/build_demo.py [--out DIR]

`--out` (default fixtures/demo) is deleted and recreated; nothing else is
touched, and a folder holding subfolders (not a demo build) is refused.
External tools: ffmpeg and ffprobe must be on PATH (the video items).

The demo is a guided tour, not a story: one section per content feature,
and every line of text explains what is on screen (docs/plan.md Phase 18).
Sections, in order: intro card; speech / thought / narration / a bare
picture; an animation; a video under a text chain and a chain over a
still; loopCount (MP4) and holdSeconds (WebM); two ranges of one file with
a loop restart point; a minimum-play-time clip; branches (an outer
decision with a continuing route that holds a nested continuing/return
pair, an ending route, shared aftermath).

The output is deterministic: two runs with fixtures/demo deleted in between
produce byte-identical files. Everything is drawn with integer arithmetic in
Pillow (no fonts, no RNG, no timestamps). JPEGs use fixed quality/optimize
settings. Videos are encoded from raw frames piped to ffmpeg with bitexact
flags, stripped metadata and a single thread, so no encoder version string
or timestamps are written.

After generating, the script checks the folder with
tools/validate_content.py (the same rules as any content folder: the
schema, media files, ids, text items, video ranges, branches and the
manifest.js shim) and checks that every image is WIDTH x HEIGHT. It exits 1
with one line per problem.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"

sys.path.insert(0, str(REPO_ROOT / "tools"))
import validate_content  # noqa: E402

WIDTH = 960
HEIGHT = 540
VIDEO_FPS = 25
JPEG_QUALITY = 82

# --------------------------------------------------------------------------
# Drawing helpers (pure integer arithmetic, fully deterministic)
# --------------------------------------------------------------------------

def new_canvas(top: tuple[int, int, int], bottom: tuple[int, int, int]):
    """Vertical linear gradient canvas, blended per row with integer math."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(img)
    span = max(HEIGHT - 1, 1)
    for y in range(HEIGHT):
        color = tuple(
            (top[c] * (span - y) + bottom[c] * y) // span for c in range(3)
        )
        draw.line([(0, y), (WIDTH, y)], fill=color)
    return img


def circle(img, cx: int, cy: int, r: int, color: tuple[int, int, int]) -> None:
    from PIL import ImageDraw

    ImageDraw.Draw(img).ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)


def rect(img, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
    from PIL import ImageDraw

    ImageDraw.Draw(img).rectangle([x0, y0, x1, y1], fill=color)


def save_jpeg(img, path: Path) -> None:
    """Fixed encoder settings; Pillow embeds no timestamps in JPEG output."""
    img.save(path, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=False)


def start_encoder(path: Path) -> subprocess.Popen:
    """ffmpeg reading WIDTH x HEIGHT rgb24 frames from stdin.

    The bitexact flags, single thread and stripped metadata are what make
    the mp4 byte-identical across runs (module docstring).
    """
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(VIDEO_FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-threads", "1",
        "-fflags", "+bitexact", "-flags", "+bitexact",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-movflags", "+faststart",
        str(path),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    return proc


def finish_encoder(proc: subprocess.Popen) -> None:
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg failed with exit code {proc.returncode}")


def probe_duration(path: Path) -> float:
    """The encoded file's own duration, seconds, rounded to 3 places."""
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        check=True, capture_output=True, text=True,
    )
    return round(float(probe.stdout.strip()), 3)


# --------------------------------------------------------------------------
# Item generators
# --------------------------------------------------------------------------


def extract_poster(mp4: Path, seconds: float, poster: Path) -> None:
    """Extract one frame at `seconds` as the poster (deterministic encode).

    The same bitexact discipline as `start_encoder`: fixed decoders/encoders,
    no metadata, so two runs write the same bytes. `-ss` before `-i` is an
    input seek; with the file's GOP the target lands on a keyframe, so the
    decoded frame is exact.
    """
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", f"{seconds:.3f}", "-i", str(mp4), "-frames:v", "1",
         "-fflags", "+bitexact", "-flags", "+bitexact",
         "-map_metadata", "-1", "-map_chapters", "-1", str(poster)],
        check=True,
    )



# --------------------------------------------------------------------------
# Demo content: one section per feature, every line explanatory
# --------------------------------------------------------------------------
#
# The demo exists to SHOW the player's features, so no line tells a story:
# each says what is on screen and why (user, docs/plan.md Phase 18). Section
# title cards are plain image items (a dark card plus a line of text) so they
# never join a neighbouring text chain. Item ids name the section they belong
# to; the scenario suite (player/scripts/scenarios/) finds items by id.


def scene(out: Path, name: str, top, bottom, *shapes) -> None:
    """Save `<name>.jpg`: a gradient with circles ("c", (cx, cy, r), color)
    and rectangles ("r", (x0, y0, x1, y1), color) drawn in order."""
    img = new_canvas(top, bottom)
    for kind, args, color in shapes:
        (circle if kind == "c" else rect)(img, *args, color)
    save_jpeg(img, out / f"{name}.jpg")


def card(out: Path, item_id: str, text: str) -> dict:
    """A section title card: near-black canvas with a thin accent rule."""
    img = new_canvas((14, 14, 18), (24, 22, 26))
    rect(img, WIDTH // 2 - 90, HEIGHT // 2 - 2, WIDTH // 2 + 90,
         HEIGHT // 2 + 2, (196, 164, 104))
    save_jpeg(img, out / f"{item_id}.jpg")
    return {"id": item_id, "type": "image", "file": f"{item_id}.jpg",
            "text": text}


def encode(path: Path, frames, codec: str = "h264") -> float:
    """Encode an iterable of canvases; returns the probed duration."""
    if codec == "h264":
        proc = start_encoder(path)
    else:  # VP9 in WebM, with the same bitexact discipline
        proc = subprocess.Popen([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{WIDTH}x{HEIGHT}", "-r", str(VIDEO_FPS), "-i", "-",
            "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40",
            "-deadline", "good", "-cpu-used", "4", "-row-mt", "0",
            "-pix_fmt", "yuv420p", "-threads", "1",
            "-fflags", "+bitexact", "-flags", "+bitexact",
            "-map_metadata", "-1", "-map_chapters", "-1", str(path),
        ], stdin=subprocess.PIPE)
    assert proc.stdin is not None
    for img in frames:
        proc.stdin.write(img.tobytes())
    finish_encoder(proc)
    return probe_duration(path)


def section_intro(out: Path) -> list[dict]:
    return [card(
        out, "intro-title",
        "Kinetic demo. Every line explains what you are seeing. Space shows "
        "the next item; the mouse wheel scrolls back and forth through what "
        "you have read; Esc shows the keys and settings.",
    )]


def section_text(out: Path) -> list[dict]:
    """Speech, thought, narration, a bare picture, and `h`."""
    img = new_canvas((96, 158, 224), (208, 232, 250))
    circle(img, 760, 120, 70, (255, 244, 200))
    rect(img, 0, 430, WIDTH, HEIGHT, (86, 148, 92))
    save_jpeg(img, out / "text-speech.jpg")

    bare = new_canvas((240, 128, 64), (146, 42, 62))
    circle(bare, WIDTH // 2, HEIGHT // 2, 150, (252, 226, 168))
    circle(bare, WIDTH // 2, HEIGHT // 2, 96, (240, 128, 64))
    save_jpeg(bare, out / "text-bare.jpg")

    return [
        {"id": "text-speech", "type": "image", "file": "text-speech.jpg",
         "speaker": "Mei",
         "text": "Spoken dialogue: the speaker's name, Mei, sits above it."},
        {"id": "text-thought", "type": "text", "speaker": "Mei",
         "thought": True,
         "text": "A thought: unspoken, so it is drawn differently from speech."},
        {"id": "text-narration", "type": "text",
         "text": "Narration has no name. Press h to hide all text; press h "
                 "again to bring it back."},
        {"id": "text-bare", "type": "image", "file": "text-bare.jpg"},
    ]


def section_animation(out: Path) -> list[dict]:
    frames = []
    cx, cy, radius = WIDTH // 2, HEIGHT // 2, 170
    for n in range(4):
        img = new_canvas((18, 18, 30), (46, 30, 30))
        px = cx + [radius, 0, -radius, 0][n]
        py = cy + [0, -radius, 0, radius][n]
        for rr, color in ((34, (255, 200, 80)), (20, (255, 240, 180))):
            circle(img, px, py, rr, color)
        circle(img, cx, cy, 26, (200, 80, 60))
        name = f"anim-orbit.f{n:03d}.jpg"
        save_jpeg(img, out / name)
        frames.append(name)
    return [{
        "id": "anim-orbit", "type": "animation", "frames": frames,
        "fps": 8, "loopCount": 2,
        "text": "An animation: four pictures at 8 per second, shown twice, "
                "then it rests on the last one.",
    }]


def section_video_chain(out: Path) -> list[dict]:
    """A video with a chain of text items over it, then a chain over a still."""
    band_w = 120

    def frame(n: int):
        img = new_canvas((12, 24, 40), (34, 52, 74))
        x = (n * 11) % (WIDTH - band_w)
        rect(img, x, 150, x + band_w, 390, (90, 200, 170))
        return img

    mp4 = out / "video-chain.mp4"
    duration = encode(mp4, (frame(n) for n in range(VIDEO_FPS * 2)))
    save_jpeg(frame(0), out / "video-chain.poster.jpg")

    still = new_canvas((42, 30, 58), (96, 70, 64))
    rect(still, 0, 400, WIDTH, HEIGHT, (30, 24, 34))
    circle(still, 480, 250, 40, (250, 210, 150))
    save_jpeg(still, out / "chain-still.jpg")

    return [
        {"id": "video-chain", "type": "video", "file": "video-chain.mp4",
         "poster": "video-chain.poster.jpg", "durationSeconds": duration,
         "text": "A video. It keeps looping while this line and the next two "
                 "are read."},
        {"id": "video-chain-2", "type": "text", "speaker": "Theo",
         "text": "Second line of the chain: the same clip plays on underneath."},
        {"id": "video-chain-3", "type": "text", "thought": True,
         "text": "Third line, a thought. Scroll back onto the video to see its "
                 "still poster."},
        {"id": "chain-still", "type": "image", "file": "chain-still.jpg"},
        {"id": "chain-still-2", "type": "text", "speaker": "Theo",
         "text": "Lines can chain over a still picture too."},
        {"id": "chain-still-3", "type": "text", "thought": True,
         "text": "A thought over the same still."},
    ]


def section_loops(out: Path) -> list[dict]:
    """`loopCount` on a short MP4, `holdSeconds` on a WebM."""

    def pulse(n: int):
        img = new_canvas((30, 20, 44), (70, 44, 90))
        r = 40 + (n % VIDEO_FPS) * 3
        circle(img, WIDTH // 2, HEIGHT // 2, r, (230, 170, 220))
        return img

    loops = out / "video-loops.mp4"
    loops_duration = encode(loops, (pulse(n) for n in range(VIDEO_FPS)))
    save_jpeg(pulse(0), out / "video-loops.poster.jpg")

    def kettle(n: int):
        img = new_canvas((30, 24, 20), (92, 70, 52))
        rise = (n * 6) % 160
        circle(img, WIDTH // 2, 330, 90, (60, 60, 66))
        circle(img, WIDTH // 2 - 30, 210 - rise, 18, (200, 196, 190))
        circle(img, WIDTH // 2 + 20, 240 - rise, 14, (210, 206, 200))
        return img

    webm = out / "video-hold.webm"
    hold_duration = encode(webm, (kettle(n) for n in range(VIDEO_FPS * 2)),
                           codec="vp9")
    save_jpeg(kettle(0), out / "video-hold.poster.jpg")

    return [
        {"id": "video-loops", "type": "video", "file": "video-loops.mp4",
         "poster": "video-loops.poster.jpg", "durationSeconds": loops_duration,
         "loopCount": 3,
         # Short on purpose: its reading time (1.5 s minimum) must stay
         # under the 3 passes, so the passes are what hold it in auto mode.
         "text": "Loop count 3: three passes."},
        {"id": "video-hold", "type": "video", "file": "video-hold.webm",
         "poster": "video-hold.poster.jpg", "durationSeconds": hold_duration,
         "holdSeconds": 4,
         # Under 4 s of reading time, so holdSeconds is what governs.
         "text": "A WebM clip held 4 s, looping in the background."},
    ]


# One distinct background per quarter of the shared clip, so every range
# boundary and the loop restart point are visible.
CLIP_QUARTERS = [
    ((16, 42, 32), (74, 118, 84)),    # green
    ((42, 22, 52), (96, 58, 110)),    # violet
    ((44, 20, 22), (110, 58, 52)),    # rust
    ((18, 34, 56), (58, 90, 132)),    # blue
]


def section_ranges(out: Path) -> list[dict]:
    """Two items over ONE 2 s file: [0, 1] once, then [1, 2] twice with the
    repeat restarting at 1.5 s. Each has its own poster from its range."""
    frames_total = VIDEO_FPS * 2

    def frame(n: int):
        quarter = (n * 4) // frames_total
        top, bottom = CLIP_QUARTERS[min(quarter, 3)]
        img = new_canvas(top, bottom)
        x = 90 + (n * (WIDTH - 180)) // (frames_total - 1)
        circle(img, x, HEIGHT // 2, 44, (236, 206, 120))
        return img

    mp4 = out / "range-clip.mp4"
    duration = encode(mp4, (frame(n) for n in range(frames_total)))
    extract_poster(mp4, 0.0, out / "range-a.poster.jpg")
    extract_poster(mp4, 1.0, out / "range-b.poster.jpg")
    return [
        {"id": "range-a", "type": "video", "file": "range-clip.mp4",
         "poster": "range-a.poster.jpg", "durationSeconds": duration,
         "startSeconds": 0.0, "endSeconds": 1.0, "loopCount": 1,
         "text": "One video file, first range: seconds 0 to 1 (green, then "
                 "violet)."},
        {"id": "range-b", "type": "video", "file": "range-clip.mp4",
         "poster": "range-b.poster.jpg", "durationSeconds": duration,
         "startSeconds": 1.0, "endSeconds": 2.0, "loopCount": 2,
         "loopStartSeconds": 1.5,
         "text": "Same file, seconds 1 to 2, shown twice. The repeat restarts "
                 "at 1.5 s, so it skips the rust part."},
    ]


FLOOR_SECONDS_COLORS = [
    ((14, 38, 30), (66, 106, 78)),
    ((38, 20, 48), (88, 52, 102)),
    ((40, 18, 20), (104, 52, 46)),
    ((16, 32, 54), (54, 84, 126)),
    ((46, 40, 14), (112, 100, 40)),
    ((22, 20, 44), (64, 62, 112)),
]
FLOOR_MIN_PLAY = 4.5


def section_floor(out: Path) -> list[dict]:
    """`minPlaySeconds` under a chain of deliberately short lines (each hold
    is the minimum, so only the floor can explain the wait in auto mode)."""
    frames_total = VIDEO_FPS * 6

    def frame(n: int):
        second = min((n * 6) // frames_total, 5)
        top, bottom = FLOOR_SECONDS_COLORS[second]
        img = new_canvas(top, bottom)
        x = 100 + (n * (WIDTH - 200)) // (frames_total - 1)
        circle(img, x, HEIGHT // 2 + 60, 36, (232, 200, 120))
        return img

    mp4 = out / "floor-clip.mp4"
    duration = encode(mp4, (frame(n) for n in range(frames_total)))
    save_jpeg(frame(0), out / "floor-clip.poster.jpg")
    return [
        card(out, "floor-title",
             "Next: a clip with a minimum play time of 4.5 s. In auto mode "
             "its three short lines read fast, then the last waits for the "
             "clip. Space and tab never wait."),
        {"id": "floor-clip", "type": "video", "file": "floor-clip.mp4",
         "poster": "floor-clip.poster.jpg", "durationSeconds": duration,
         "minPlaySeconds": FLOOR_MIN_PLAY, "text": "Short line one."},
        {"id": "floor-2", "type": "text", "text": "Short line two."},
        {"id": "floor-3", "type": "text", "text": "Line three waits."},
    ]


def section_branches(out: Path) -> tuple[list[dict], list[dict]]:
    """Two decisions: an outer one with a continuing route (containing a
    nested continuing/return pair) and an ending route, then aftermath."""

    scene(out, "branch-lead", (70, 58, 96), (196, 178, 150),
          ("r", (320, 170, 640, 390), (250, 236, 208)),
          ("r", (452, 260, 508, 390), (120, 96, 70)))
    scene(out, "branch-decide", (40, 52, 82), (150, 130, 92),
          ("c", (WIDTH // 2, 280, 120), (232, 204, 150)),
          ("r", (380, 280, 580, 430), (90, 70, 56)))
    scene(out, "route1-start", (58, 70, 48), (178, 190, 150),
          ("r", (250, 240, 710, 300), (226, 214, 190)),
          ("r", (430, 210, 530, 240), (250, 244, 226)))
    scene(out, "route2-start", (52, 40, 40), (158, 120, 108),
          ("r", (0, 380, WIDTH, HEIGHT), (60, 46, 44)),
          ("c", (480, 200, 60), (244, 226, 198)))
    scene(out, "after-start", (90, 96, 130), (210, 204, 178),
          ("c", (700, 130, 64), (254, 246, 214)),
          ("r", (0, 420, WIDTH, HEIGHT), (96, 108, 92)))

    items = [
        card(out, "branch-title",
             "Next: a decision. Route 1 continues the story and holds a "
             "nested decision; Route 2 is an ending. After a route ends you "
             "can pick another."),
        {"id": "branch-lead", "type": "image", "file": "branch-lead.jpg",
         "text": "Shared lead-in: every route starts after this. The decision "
                 "opens when you press Space here."},
        {"id": "branch-decide", "type": "image", "file": "branch-decide.jpg"},
        {"id": "route1-start", "type": "image", "file": "route1-start.jpg",
         "speaker": "Mei",
         "text": "Route 1, first line. A nested decision opens after the next "
                 "line."},
        {"id": "route1-nest", "type": "text", "speaker": "Theo",
         "text": "Route 1, second line: the nested decision hangs off this "
                 "one."},
        {"id": "nest-continue", "type": "text",
         "text": "Nested 1a: when it ends, Route 1 carries on."},
        {"id": "nest-return", "type": "text",
         "text": "Nested 1b: when it ends, the nested decision is offered "
                 "again."},
        {"id": "route1-end", "type": "text",
         "text": "Route 1 again, after the nested decision. Its end leads to "
                 "the shared ending section."},
        {"id": "route2-start", "type": "image", "file": "route2-start.jpg",
         "speaker": "Mei",
         "text": "Route 2: a separate path that does not rejoin the story."},
        {"id": "route2-end", "type": "text",
         "text": "Route 2 ends here: this is an ending. Space offers the "
                 "routes again."},
        {"id": "after-start", "type": "image", "file": "after-start.jpg",
         "text": "Shared aftermath: reached by finishing Route 1. Return to "
                 "main route jumps here once Route 1 is done."},
        {"id": "after-end", "type": "text",
         "text": "The end. Also try: u for unseen content, e for the end of "
                 "what you have read, b and t for bookmarks, Esc for the keys "
                 "and settings, a for auto-play, tab to skip what you have "
                 "read."},
    ]
    branches = [
        {
            "id": "nested", "after": "route1-nest",
            "prompt": "Nested decision inside Route 1:",
            "routes": [
                {"id": "nest-a", "label": "1a: carries on with Route 1",
                 "start": "nest-continue", "end": "nest-continue"},
                {"id": "nest-b", "label": "1b: comes back to this decision",
                 "start": "nest-return", "end": "nest-return",
                 "result": "return"},
            ],
            "continuingRoute": "nest-a", "continueAt": "route1-end",
        },
        {
            "id": "outer", "after": "branch-decide",
            "prompt": "Demo decision: which route?",
            "routes": [
                {"id": "route1", "label": "Route 1: continues the story",
                 "start": "route1-start", "end": "route1-end",
                 "result": "return"},
                {"id": "route2", "label": "Route 2: an ending",
                 "start": "route2-start", "end": "route2-end",
                 "result": "ending"},
            ],
            "continuingRoute": "route1", "continueAt": "after-start",
        },
    ]
    return items, branches


# --------------------------------------------------------------------------
# Check: tools/validate_content.py, plus what only the demo promises
# --------------------------------------------------------------------------


def image_paths(item: dict) -> list[str]:
    """The image files an item references (a video's `file` is not one)."""
    if item["type"] == "image":
        return [item["file"]]
    if item["type"] == "animation":
        return item["frames"]
    if item["type"] == "video":
        return [item["poster"]]
    return []


def image_size_problems(out: Path, items: list[dict]) -> list[str]:
    """Every image is WIDTH x HEIGHT, the manifest's size; the content
    format allows any size, so the validator does not check this. A missing
    file is the validator's problem."""
    from PIL import Image

    problems: list[str] = []
    for item in items:
        for name in image_paths(item):
            if not (out / name).is_file():
                continue
            with Image.open(out / name) as im:
                if im.size != (WIDTH, HEIGHT):
                    problems.append(f"{name}: is {im.width}x{im.height}, "
                                    f"expected {WIDTH}x{HEIGHT}")
    return problems


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def reset_dir(out: Path) -> None:
    """Delete and recreate `out`. The demo is flat, so a folder that holds
    a subfolder is not a demo build: refuse to delete it."""
    if out.is_dir():
        if any(p.is_dir() for p in out.iterdir()):
            sys.exit(f"{out}: holds subfolders, so it is not a demo build; "
                     "not deleting it")
        shutil.rmtree(out)
    out.mkdir(parents=True)


def write_manifest(out: Path, manifest: dict) -> None:
    """Write manifest.json and its manifest.js shim."""
    manifest_text = json.dumps(manifest, indent=2, ensure_ascii=True)
    (out / "manifest.json").write_text(manifest_text + "\n",
                                       encoding="utf-8")
    (out / "manifest.js").write_text(
        validate_content.SHIM_PREFIX + manifest_text + ";\n",
        encoding="utf-8")


def folder_problems(out: Path, items: list[dict]) -> list[str]:
    """The validator's problems plus any image not WIDTH x HEIGHT."""
    return (validate_content.validate_folder(out)
            + image_size_problems(out, items))


def report(out: Path, problems: list[str]) -> None:
    """Exit 1 with one line per problem, else say what was written."""
    if problems:
        for problem in problems:
            print(f"schema check FAIL: {problem}", file=sys.stderr)
        sys.exit(1)

    names = sorted(p.name for p in out.iterdir())
    print(f"wrote {len(names)} files to {out}")
    print("schema check OK")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the Kinetic feature demo content folder.")
    parser.add_argument("--out", type=Path, default=DEMO_DIR,
                        help="folder to delete and recreate "
                             f"(default: {DEMO_DIR})")
    out = parser.parse_args().out
    reset_dir(out)

    items: list[dict] = []
    items += section_intro(out)
    items += section_text(out)
    items += section_animation(out)
    items += section_video_chain(out)
    items += section_loops(out)
    items += section_ranges(out)
    items += section_floor(out)
    branch_items, branches = section_branches(out)
    items += branch_items
    manifest = {
        "schemaVersion": 1,
        # The demo's identity for saved progress (docs/plan.md Phase 21):
        # moving or renaming the folder keeps the reader's place.
        "storyId": "kinetic-demo",
        # The game's name atop the Esc help screen and as the page title
        # (docs/plan.md Phase 21, Game name on the Esc screen).
        "title": "Kinetic demo",
        "width": WIDTH,
        "height": HEIGHT,
        "items": items,
        "branches": branches,
    }

    write_manifest(out, manifest)
    report(out, folder_problems(out, items))


if __name__ == "__main__":
    main()
