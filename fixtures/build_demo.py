#!/usr/bin/env python3
"""Generate fixtures/demo: the Kinetic feature demo content folder.

Usage (from the repo root, Pillow lives in the repo venv):

    .venv/bin/python fixtures/build_demo.py

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

After generating, the script runs an inline structural check of
manifest.json against docs/content-schema.json and verifies that
manifest.js embeds the exact same JSON bytes and that every referenced file
exists.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_DIR = REPO_ROOT / "fixtures" / "demo"
SCHEMA_PATH = REPO_ROOT / "docs" / "content-schema.json"

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


def card(item_id: str, text: str) -> dict:
    """A section title card: near-black canvas with a thin accent rule."""
    img = new_canvas((14, 14, 18), (24, 22, 26))
    rect(img, WIDTH // 2 - 90, HEIGHT // 2 - 2, WIDTH // 2 + 90,
         HEIGHT // 2 + 2, (196, 164, 104))
    save_jpeg(img, DEMO_DIR / f"{item_id}.jpg")
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


def section_intro() -> list[dict]:
    return [card(
        "intro-title",
        "Kinetic demo. Every line explains what you are seeing. Space shows "
        "the next item; the mouse wheel scrolls back and forth through what "
        "you have read; Esc shows the main keys.",
    )]


def section_text() -> list[dict]:
    """Speech, thought, narration, a bare picture, and `h`."""
    img = new_canvas((96, 158, 224), (208, 232, 250))
    circle(img, 760, 120, 70, (255, 244, 200))
    rect(img, 0, 430, WIDTH, HEIGHT, (86, 148, 92))
    save_jpeg(img, DEMO_DIR / "text-speech.jpg")

    bare = new_canvas((240, 128, 64), (146, 42, 62))
    circle(bare, WIDTH // 2, HEIGHT // 2, 150, (252, 226, 168))
    circle(bare, WIDTH // 2, HEIGHT // 2, 96, (240, 128, 64))
    save_jpeg(bare, DEMO_DIR / "text-bare.jpg")

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


def section_animation() -> list[dict]:
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
        save_jpeg(img, DEMO_DIR / name)
        frames.append(name)
    return [{
        "id": "anim-orbit", "type": "animation", "frames": frames,
        "fps": 8, "loopCount": 2,
        "text": "An animation: four pictures at 8 per second, shown twice, "
                "then it rests on the last one.",
    }]


def section_video_chain() -> list[dict]:
    """A video with a chain of text items over it, then a chain over a still."""
    band_w = 120

    def frame(n: int):
        img = new_canvas((12, 24, 40), (34, 52, 74))
        x = (n * 11) % (WIDTH - band_w)
        rect(img, x, 150, x + band_w, 390, (90, 200, 170))
        return img

    mp4 = DEMO_DIR / "video-chain.mp4"
    duration = encode(mp4, (frame(n) for n in range(VIDEO_FPS * 2)))
    save_jpeg(frame(0), DEMO_DIR / "video-chain.poster.jpg")

    still = new_canvas((42, 30, 58), (96, 70, 64))
    rect(still, 0, 400, WIDTH, HEIGHT, (30, 24, 34))
    circle(still, 480, 250, 40, (250, 210, 150))
    save_jpeg(still, DEMO_DIR / "chain-still.jpg")

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


def section_loops() -> list[dict]:
    """`loopCount` on a short MP4, `holdSeconds` on a WebM."""

    def pulse(n: int):
        img = new_canvas((30, 20, 44), (70, 44, 90))
        r = 40 + (n % VIDEO_FPS) * 3
        circle(img, WIDTH // 2, HEIGHT // 2, r, (230, 170, 220))
        return img

    loops = DEMO_DIR / "video-loops.mp4"
    loops_duration = encode(loops, (pulse(n) for n in range(VIDEO_FPS)))
    save_jpeg(pulse(0), DEMO_DIR / "video-loops.poster.jpg")

    def kettle(n: int):
        img = new_canvas((30, 24, 20), (92, 70, 52))
        rise = (n * 6) % 160
        circle(img, WIDTH // 2, 330, 90, (60, 60, 66))
        circle(img, WIDTH // 2 - 30, 210 - rise, 18, (200, 196, 190))
        circle(img, WIDTH // 2 + 20, 240 - rise, 14, (210, 206, 200))
        return img

    webm = DEMO_DIR / "video-hold.webm"
    hold_duration = encode(webm, (kettle(n) for n in range(VIDEO_FPS * 2)),
                           codec="vp9")
    save_jpeg(kettle(0), DEMO_DIR / "video-hold.poster.jpg")

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


def section_ranges() -> list[dict]:
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

    mp4 = DEMO_DIR / "range-clip.mp4"
    duration = encode(mp4, (frame(n) for n in range(frames_total)))
    extract_poster(mp4, 0.0, DEMO_DIR / "range-a.poster.jpg")
    extract_poster(mp4, 1.0, DEMO_DIR / "range-b.poster.jpg")
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


def section_floor() -> list[dict]:
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

    mp4 = DEMO_DIR / "floor-clip.mp4"
    duration = encode(mp4, (frame(n) for n in range(frames_total)))
    save_jpeg(frame(0), DEMO_DIR / "floor-clip.poster.jpg")
    return [
        card("floor-title",
             "Next: a clip with a minimum play time of 4.5 s. In auto mode "
             "its three short lines read fast, then the last waits for the "
             "clip. Space and tab never wait."),
        {"id": "floor-clip", "type": "video", "file": "floor-clip.mp4",
         "poster": "floor-clip.poster.jpg", "durationSeconds": duration,
         "minPlaySeconds": FLOOR_MIN_PLAY, "text": "Short line one."},
        {"id": "floor-2", "type": "text", "text": "Short line two."},
        {"id": "floor-3", "type": "text", "text": "Line three waits."},
    ]


def section_branches() -> tuple[list[dict], list[dict]]:
    """Two decisions: an outer one with a continuing route (containing a
    nested continuing/return pair) and an ending route, then aftermath."""

    def scene(name: str, top, bottom, *shapes) -> None:
        img = new_canvas(top, bottom)
        for kind, args, color in shapes:
            (circle if kind == "c" else rect)(img, *args, color)
        save_jpeg(img, DEMO_DIR / f"{name}.jpg")

    scene("branch-lead", (70, 58, 96), (196, 178, 150),
          ("r", (320, 170, 640, 390), (250, 236, 208)),
          ("r", (452, 260, 508, 390), (120, 96, 70)))
    scene("branch-decide", (40, 52, 82), (150, 130, 92),
          ("c", (WIDTH // 2, 280, 120), (232, 204, 150)),
          ("r", (380, 280, 580, 430), (90, 70, 56)))
    scene("route1-start", (58, 70, 48), (178, 190, 150),
          ("r", (250, 240, 710, 300), (226, 214, 190)),
          ("r", (430, 210, 530, 240), (250, 244, 226)))
    scene("route2-start", (52, 40, 40), (158, 120, 108),
          ("r", (0, 380, WIDTH, HEIGHT), (60, 46, 44)),
          ("c", (480, 200, 60), (244, 226, 198)))
    scene("after-start", (90, 96, 130), (210, 204, 178),
          ("c", (700, 130, 64), (254, 246, 214)),
          ("r", (0, 420, WIDTH, HEIGHT), (96, 108, 92)))

    items = [
        card("branch-title",
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
                 "what you have read, b and t for bookmarks, c for settings, "
                 "a for auto-play, tab to skip what you have read."},
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
# Inline structural check (hand-rolled; the reusable validator is next task)
# --------------------------------------------------------------------------

def check_manifest(manifest: dict, schema: dict) -> list[str]:
    """Validate manifest structure against the schema fragments we need."""
    from PIL import Image

    errors: list[str] = []
    defs = schema["$defs"]
    path_re = re.compile(defs["path"]["pattern"])

    def ext_pattern(name: str) -> str:
        # imagePath/videoPath are allOf [path ref, {pattern}]; the extension
        # pattern lives in the inline branch.
        for branch in defs[name]["allOf"]:
            if "pattern" in branch:
                return branch["pattern"]
        raise KeyError(name)

    ext_res = {
        "image": re.compile(ext_pattern("imagePath")),
        "video": re.compile(ext_pattern("videoPath")),
    }
    id_re = re.compile(defs["id"]["pattern"])
    type_to_def = {"image": "imageItem", "animation": "animationItem",
                   "video": "videoItem", "text": "textItem"}

    def bad(msg: str) -> None:
        errors.append(msg)

    def check_path(value, kind: str, where: str) -> None:
        if not isinstance(value, str) or not path_re.fullmatch(value) \
                or not ext_res[kind].search(value):
            bad(f"{where}: {value!r} is not a valid {kind} path")
            return
        if not (DEMO_DIR / value).is_file():
            bad(f"{where}: {value!r} does not exist in the folder")
        if kind == "image":
            with Image.open(DEMO_DIR / value) as im:
                if im.size != (WIDTH, HEIGHT):
                    bad(f"{where}: {value!r} is {im.size}, expected "
                        f"{(WIDTH, HEIGHT)}")

    props = schema["properties"]
    if set(manifest) - set(props):
        bad(f"top level: unexpected keys {set(manifest) - set(props)}")
    for key in schema["required"]:
        if key not in manifest:
            bad(f"top level: missing required key {key!r}")
    if manifest.get("schemaVersion") != props["schemaVersion"]["const"]:
        bad(f"schemaVersion must be {props['schemaVersion']['const']}")
    story = manifest.get("storyId")
    if not isinstance(story, str) or not re.fullmatch(
            props["storyId"]["pattern"], story):
        bad(f"storyId {story!r} must match {props['storyId']['pattern']}")
    title = manifest.get("title")
    if not isinstance(title, str) or not title.strip() or \
            len(title) > props["title"]["maxLength"]:
        bad(f"title {title!r} must be non-blank text of at most "
            f"{props['title']['maxLength']} characters")
    for key in ("width", "height"):
        if not isinstance(manifest.get(key), int) or manifest.get(key, 0) < 1:
            bad(f"{key} must be an integer >= 1")
    if manifest.get("width") != WIDTH or manifest.get("height") != HEIGHT:
        bad("manifest width/height must match the generated images")

    items = manifest.get("items")
    min_items = props["items"].get("minItems", 1)
    if not isinstance(items, list) or len(items) < min_items:
        bad(f"items must be an array with >= {min_items} entries")
        return errors

    seen_ids: set[str] = set()
    for i, item in enumerate(items):
        where = f"items[{i}]"
        itype = item.get("type")
        if itype not in type_to_def:
            bad(f"{where}: unknown type {itype!r}")
            continue
        spec = defs[type_to_def[itype]]
        if not set(spec["required"]) <= set(item):
            bad(f"{where}: missing required keys "
                f"{set(spec['required']) - set(item)}")
        extra = set(item) - set(spec["properties"])
        if extra:
            bad(f"{where}: unexpected keys {extra}")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not id_re.fullmatch(item_id):
            bad(f"{where}: id {item_id!r} fails the id pattern")
        elif item_id in seen_ids:
            bad(f"{where}: duplicate id {item_id!r}")
        else:
            seen_ids.add(item_id)
        for key in ("speaker", "text"):
            if key in item and not isinstance(item[key], str):
                bad(f"{where}.{key}: must be a string")

        if itype == "image":
            check_path(item.get("file"), "image", f"{where}.file")
        elif itype == "animation":
            frames = item.get("frames")
            min_frames = spec["properties"]["frames"].get("minItems", 2)
            if not isinstance(frames, list) or len(frames) < min_frames:
                bad(f"{where}.frames: needs >= {min_frames} entries")
            else:
                for f, frame in enumerate(frames):
                    check_path(frame, "image", f"{where}.frames[{f}]")
            fps = item.get("fps")
            if not isinstance(fps, (int, float)) or fps <= 0:
                bad(f"{where}.fps: must be > 0")
            loops = item.get("loopCount")
            if not isinstance(loops, int) or isinstance(loops, bool) \
                    or loops < 1:
                bad(f"{where}.loopCount: must be an integer >= 1")
        elif itype == "video":
            check_path(item.get("file"), "video", f"{where}.file")
            check_path(item.get("poster"), "image", f"{where}.poster")
            dur = item.get("durationSeconds")
            if not isinstance(dur, (int, float)) or dur <= 0:
                bad(f"{where}.durationSeconds: must be > 0")
            # Playback ranges (Phase 9c): exact fractional seconds.
            start = item.get("startSeconds", 0)
            end = item.get("endSeconds", dur)
            if not isinstance(start, (int, float)) or start < 0:
                bad(f"{where}.startSeconds: must be >= 0")
            if not isinstance(end, (int, float)) or not end > start:
                bad(f"{where}.endSeconds: must be > startSeconds")
            elif isinstance(dur, (int, float)) and dur > 0 and end > dur:
                bad(f"{where}.endSeconds: must not exceed durationSeconds")
            # Loop restart point (Phase 9d): below the effective end
            # (`endSeconds` if present, else `durationSeconds`), else a
            # later pass has no length — the validator's cross-field rule.
            loop_start = item.get("loopStartSeconds", start)
            if not isinstance(loop_start, (int, float)) or loop_start < 0:
                bad(f"{where}.loopStartSeconds: must be >= 0")
            elif isinstance(end, (int, float)) and not loop_start < end:
                bad(f"{where}.loopStartSeconds: must be < the effective end")
            # Chain-exit floor (Phase 15): optional, and when present a
            # number greater than 0 (docs/content-format.md, "Timing").
            floor = item.get("minPlaySeconds")
            if floor is not None and (
                isinstance(floor, bool)
                or not isinstance(floor, (int, float))
                or floor <= 0
            ):
                bad(f"{where}.minPlaySeconds: must be > 0")
    return errors


def check_manifest_js(manifest_text: str, manifest: dict) -> list[str]:
    js = (DEMO_DIR / "manifest.js").read_text(encoding="utf-8")
    prefix = "window.KINETIC_MANIFEST = "
    expected = prefix + manifest_text + ";\n"
    if js != expected:
        return [f"manifest.js is not {prefix}<same JSON bytes>;"]
    if json.loads(js[len(prefix):-2]) != manifest:
        return ["manifest.js JSON does not equal manifest.json"]
    return []


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> None:
    if DEMO_DIR.is_dir():
        shutil.rmtree(DEMO_DIR)
    DEMO_DIR.mkdir(parents=True)

    items: list[dict] = []
    items += section_intro()
    items += section_text()
    items += section_animation()
    items += section_video_chain()
    items += section_loops()
    items += section_ranges()
    items += section_floor()
    branch_items, branches = section_branches()
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

    manifest_text = json.dumps(manifest, indent=2, ensure_ascii=True)
    (DEMO_DIR / "manifest.json").write_text(manifest_text + "\n",
                                            encoding="utf-8")
    (DEMO_DIR / "manifest.js").write_text(
        "window.KINETIC_MANIFEST = " + manifest_text + ";\n",
        encoding="utf-8")

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    errors = check_manifest(manifest, schema)
    errors += check_manifest_js(manifest_text, manifest)
    if errors:
        for err in errors:
            print(f"schema check FAIL: {err}", file=sys.stderr)
        sys.exit(1)

    names = sorted(p.name for p in DEMO_DIR.iterdir())
    print(f"wrote {len(names)} files to {DEMO_DIR}")
    print("schema check OK")


if __name__ == "__main__":
    main()
