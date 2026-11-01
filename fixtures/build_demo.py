#!/usr/bin/env python3
"""Generate fixtures/demo: a complete, schema-valid Kinetic demo content folder.

Usage (from the repo root, Pillow lives in the repo venv):

    .venv/bin/python fixtures/build_demo.py

External tools: ffmpeg and ffprobe must be on PATH (the video item).

The output is deterministic: two runs with fixtures/demo deleted in between
produce byte-identical files. Everything is drawn with integer arithmetic in
Pillow (no fonts, no RNG, no timestamps). JPEGs use fixed quality/optimize
settings. The mp4 is encoded from raw frames piped to ffmpeg with
-fflags +bitexact -flags +bitexact, -map_metadata -1, -threads 1, and
-movflags +faststart, so no encoder version string or timestamps are written.

After generating, the script runs an inline structural check of
manifest.json against docs/content-schema.json (a small hand-rolled checker;
the reusable validator is the next task) and verifies that manifest.js
embeds the exact same JSON bytes and that every referenced file exists.
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

VIDEO_ID = "intro-006"
VIDEO_FPS = 25
VIDEO_SECONDS = 2
VIDEO_FRAMES = VIDEO_FPS * VIDEO_SECONDS

CLIP_ID = "clip-012"
CLIP_SECONDS = 2.0
CLIP_FRAMES = VIDEO_FPS * 2  # 2.0 s at the same 25 fps

STROLL_ID = "stroll-025"
STROLL_SECONDS = 6.0
STROLL_FRAMES = VIDEO_FPS * 6  # 6.0 s at the same 25 fps
STROLL_MIN_PLAY = 4.5

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

def build_image_items() -> list[dict]:
    items: list[dict] = []

    img = new_canvas((96, 158, 224), (208, 232, 250))
    circle(img, 760, 120, 70, (255, 244, 200))
    rect(img, 0, 430, WIDTH, HEIGHT, (86, 148, 92))
    save_jpeg(img, DEMO_DIR / "meadow-001.jpg")
    items.append({
        "id": "meadow-001", "type": "image", "file": "meadow-001.jpg",
        "speaker": "Mei", "text": "You're early today. The meadow is empty.",
    })

    img = new_canvas((14, 16, 38), (52, 30, 58))
    for x in range(80, WIDTH, 160):
        rect(img, x, 260, x + 56, 330, (240, 170, 70))
        rect(img, x + 22, 240, x + 34, 262, (120, 90, 50))
    save_jpeg(img, DEMO_DIR / "lantern-002.jpg")
    items.append({
        "id": "lantern-002", "type": "image", "file": "lantern-002.jpg",
        "text": "Lanterns lined the empty street, one for each guest who never came.",
    })

    # Bare visual: no text, no speaker — nothing is drawn over it.
    img = new_canvas((240, 128, 64), (146, 42, 62))
    circle(img, WIDTH // 2, HEIGHT // 2, 150, (252, 226, 168))
    circle(img, WIDTH // 2, HEIGHT // 2, 96, (240, 128, 64))
    save_jpeg(img, DEMO_DIR / "sunset-003.jpg")
    items.append({"id": "sunset-003", "type": "image", "file": "sunset-003.jpg"})

    img = new_canvas((28, 36, 58), (60, 72, 96))
    for i in range(64):
        x = (i * 71) % WIDTH
        y = (i * 137) % (HEIGHT - 120)
        rect(img, x, y, x + 3, y + 42, (168, 190, 220))
    save_jpeg(img, DEMO_DIR / "window-004.jpg")
    items.append({
        "id": "window-004", "type": "image", "file": "window-004.jpg",
        "speaker": "Theo", "text": "Rain again. It's always rain in this town.",
    })

    return items


def build_animation_item() -> dict:
    frames = []
    cx, cy, radius = WIDTH // 2, HEIGHT // 2, 170
    for n in range(4):
        img = new_canvas((18, 18, 30), (46, 30, 30))
        # Integer "orbit": quarter-turn positions, no trig, no floats.
        px = cx + [radius, 0, -radius, 0][n]
        py = cy + [0, -radius, 0, radius][n]
        for rr, color in ((34, (255, 200, 80)), (20, (255, 240, 180))):
            circle(img, px, py, rr, color)
        circle(img, cx, cy, 26, (200, 80, 60))
        name = f"spark-005.f{n:03d}.jpg"
        save_jpeg(img, DEMO_DIR / name)
        frames.append(name)
    return {
        "id": "spark-005", "type": "animation", "frames": frames,
        "fps": 8, "loopCount": 2,
        "text": "Sparks circled the bonfire and went out one by one.",
    }


def build_video_item() -> dict:
    """Encode VIDEO_FRAMES raw frames through ffmpeg; poster is frame 0."""
    mp4 = DEMO_DIR / f"{VIDEO_ID}.mp4"
    proc = start_encoder(mp4)
    band_w = 120
    for n in range(VIDEO_FRAMES):
        img = new_canvas((12, 24, 40), (34, 52, 74))
        x = (n * 11) % (WIDTH - band_w)
        rect(img, x, 150, x + band_w, 390, (90, 200, 170))
        proc.stdin.write(img.tobytes())
    finish_encoder(proc)
    duration = probe_duration(mp4)

    # The poster is exactly the first encoded source frame (format doc:
    # "the video's first frame"), saved with the same JPEG settings.
    poster = new_canvas((12, 24, 40), (34, 52, 74))
    rect(poster, 0, 150, band_w, 390, (90, 200, 170))
    save_jpeg(poster, DEMO_DIR / f"{VIDEO_ID}.poster.jpg")

    return {
        "id": VIDEO_ID, "type": "video",
        "file": f"{VIDEO_ID}.mp4", "poster": f"{VIDEO_ID}.poster.jpg",
        "durationSeconds": duration,
        "text": "The ferry crossed once a day, and that was enough.",
    }


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


# Background colours, one per quarter-second — distinct enough that a pass
# boundary landing inside the clip is visible and observable in the verifier.
CLIP_QUARTERS = [
    ((16, 42, 32), (74, 118, 84)),    # green
    ((42, 22, 52), (96, 58, 110)),    # violet
    ((44, 20, 22), (110, 58, 52)),    # rust
    ((18, 34, 56), (58, 90, 132)),    # blue
]


def build_clip_video_items() -> list[dict]:
    """The 2.0 s clip `clip-012.mp4` and the two range items over it.

    Replaces Phase 9b's standalone `loop-012` (docs/plan.md Phase 9c): ONE
    2.0 s file (25 fps, 50 frames, a distinct background per half-second so
    every range boundary shows a visible change, plus a circle crossing the
    frame continuously so playback position is observable), referenced by
    two bare visual items at different ranges:

    - part-012: [0.0, 1.0], `loopCount` 1, poster extracted at 0.0;
    - part-013: [1.0, 2.0], `loopCount` 2, `loopStartSeconds` 1.5
      (docs/plan.md Phase 9d: the first pass plays [1.0, 2.0], the
      loop-back restarts at 1.5 — the colour change at ~1.5 s makes the
      restart point observable), poster extracted at 1.0.

    Together they exercise sharing + ranges + per-range posters; the
    renderer loops each range itself (never `loop=true`), seeking back
    to `startSeconds` on entry and `loopStartSeconds` on the loop-back,
    and the machine counts pass completes per item as in Phase 9b.
    """

    def frame(n: int):
        quarter = (n * 4) // CLIP_FRAMES  # frames 0-12, 13-24, 25-37, 38-49
        top, bottom = CLIP_QUARTERS[min(quarter, 3)]
        img = new_canvas(top, bottom)
        x = 90 + (n * (WIDTH - 180)) // (CLIP_FRAMES - 1)
        circle(img, x, HEIGHT // 2, 44, (236, 206, 120))
        return img

    mp4 = DEMO_DIR / f"{CLIP_ID}.mp4"
    proc = start_encoder(mp4)
    for n in range(CLIP_FRAMES):
        proc.stdin.write(frame(n).tobytes())
    finish_encoder(proc)
    duration = probe_duration(mp4)

    items = [
        {
            "id": "part-012", "type": "video",
            "file": f"{CLIP_ID}.mp4", "poster": "part-012.poster.jpg",
            "durationSeconds": duration,
            "startSeconds": 0.0, "endSeconds": 1.0, "loopCount": 1,
        },
        {
            "id": "part-013", "type": "video",
            "file": f"{CLIP_ID}.mp4", "poster": "part-013.poster.jpg",
            "durationSeconds": duration,
            "startSeconds": 1.0, "endSeconds": 2.0, "loopCount": 2,
            "loopStartSeconds": 1.5,
        },
    ]
    extract_poster(mp4, 0.0, DEMO_DIR / "part-012.poster.jpg")
    extract_poster(mp4, 1.0, DEMO_DIR / "part-013.poster.jpg")
    return items


# One distinct background per second of the stroll clip: a pass boundary or
# a chain step landing inside the clip stays visible, as with clip-012.
STROLL_SECONDS_COLORS = [
    ((14, 38, 30), (66, 106, 78)),     # green
    ((38, 20, 48), (88, 52, 102)),     # violet
    ((40, 18, 20), (104, 52, 46)),     # rust
    ((16, 32, 54), (54, 84, 126)),     # blue
    ((46, 40, 14), (112, 100, 40)),    # ochre
    ((22, 20, 44), (64, 62, 112)),     # dusk
]


def build_stroll_chain_items() -> list[dict]:
    """The Phase 15 chain: a ~6 s clip with a floor and two dialogue lines.

    docs/plan.md Phase 15: the external tester saw an 8 s video's chain exit
    gate on the text holds alone. `stroll-025` (25 fps, 150 frames, one
    distinct background per second and one circle drifting slowly across the
    whole clip, so playback position is observable) carries
    `minPlaySeconds: 4.5` and the chain's FIRST spoken line; `line-026` and
    `line-027` follow it as bare `text` items — a classic chain, entered
    and left in array order. The lines are deliberately short (each hold is
    the minHold, so the text sum cannot stand in for the floor). The chain
    sits between the range items and the branch lead-in, so the branch
    walk's auto-advance plays through it and verify re-enters it by
    navigation (the floor measures from the re-entry).
    """

    def frame(n: int):
        second = min((n * 6) // STROLL_FRAMES, 5)
        top, bottom = STROLL_SECONDS_COLORS[second]
        img = new_canvas(top, bottom)
        x = 100 + (n * (WIDTH - 200)) // (STROLL_FRAMES - 1)
        circle(img, x, HEIGHT // 2 + 60, 36, (232, 200, 120))
        return img

    mp4 = DEMO_DIR / f"{STROLL_ID}.mp4"
    proc = start_encoder(mp4)
    for n in range(STROLL_FRAMES):
        proc.stdin.write(frame(n).tobytes())
    finish_encoder(proc)
    duration = probe_duration(mp4)

    # The poster is exactly the first encoded source frame, as with intro-006.
    save_jpeg(frame(0), DEMO_DIR / f"{STROLL_ID}.poster.jpg")

    return [
        {
            "id": STROLL_ID, "type": "video",
            "file": f"{STROLL_ID}.mp4", "poster": f"{STROLL_ID}.poster.jpg",
            "durationSeconds": duration,
            "minPlaySeconds": STROLL_MIN_PLAY,
            "speaker": "Mei", "text": "The light went long.",
        },
        {"id": "line-026", "type": "text", "text": "We did not hurry."},
        {
            "id": "line-027", "type": "text", "thought": True,
            "text": "The path turned soon.",
        },
    ]


def build_text_chain_items() -> list[dict]:
    """Items that exercise the `text` type (docs/content-format.md §Text items).

    A `text` item carries no media fields; it shows the visual of the nearest
    earlier media-bearing item, which keeps playing/looping beneath a chain of
    them. Returned in manifest order to append after the video item:

    - two lines over the looping video (intro-006);
    - a still (pier-009) followed by two lines.

    One line in each chain is marked `thought: true` (docs/plan.md Phase 7b),
    so the demo shows both presentation modes over both kinds of visual. Only
    the flag differs: ids, order and the text strings are unchanged, and a
    `thought` changes no timing, so the output stays deterministic.
    """
    # Chain over the video: a spoken line with a speaker, then Mei's unspoken
    # thought, with no media fields of its own.
    items: list[dict] = [
        {"id": "line-007", "type": "text", "speaker": "Mei",
         "text": "The street glowed under the awning."},
        {"id": "line-008", "type": "text", "thought": True,
         "text": "Neither of us spoke for a while."},
    ]

    # Chain over one still: a bare image (no overlaid text), then Theo's
    # spoken line drawn over it, then a thought over the same still.
    img = new_canvas((42, 30, 58), (96, 70, 64))
    rect(img, 0, 400, WIDTH, HEIGHT, (30, 24, 34))
    circle(img, 480, 250, 40, (250, 210, 150))
    save_jpeg(img, DEMO_DIR / "pier-009.jpg")
    items.append({"id": "pier-009", "type": "image", "file": "pier-009.jpg"})
    items.append({
        "id": "line-010", "type": "text", "speaker": "Theo",
        "text": "The tide took the last of the crates by morning.",
    })
    items.append({
        "id": "line-011", "type": "text", "thought": True,
        "text": "We stacked the rest ourselves, and called it enough.",
    })

    return items


def build_branch_items() -> tuple[list[dict], list[dict]]:
    """Phase 13's real branch demo, appended after the linear items.

    The item array stays the single source of order; ids only name
    positions (docs/content-format.md § Branches). Array layout:

        13 bridge-014  14 bridge-015          lead-in; bridge-015 is the
                                              decision's `after` item
        15 hire-016    16 hire-017            route "hire" (continuing)
        17 late-021    18 early-022           nested decision's routes
        19 hire-018                           the nested continueAt rejoin
        20 refuse-019 21 refuse-020           route "refuse" (ending)
        22 main-023   23 main-024             aftermath (continueAt)

    `outer-hire` fires on the settle of bridge-015: `hire` is the
    continuing route (it proceeds to main-023), `refuse` is an explicit
    `ending`. Inside the hire span, `inner-time` hangs off hire-017 with
    `late` (continuing, rejoining at hire-018) and `early` (`return` — the
    only route that offers "Return to main route") — exactly the nesting
    the format doc promises. Every new image is drawn with the same
    deterministic helpers as the rest of the fixture.
    """
    items: list[dict] = []

    img = new_canvas((70, 58, 96), (196, 178, 150))
    rect(img, 320, 170, 640, 390, (250, 236, 208))
    rect(img, 452, 260, 508, 390, (120, 96, 70))
    save_jpeg(img, DEMO_DIR / "bridge-014.jpg")
    items.append({
        "id": "bridge-014", "type": "image", "file": "bridge-014.jpg",
        "speaker": "Mei",
        "text": "The studio waited on an answer about the temp.",
    })

    # The decision's `after` item: its own bare image, no text — the
    # prompt lives in the branch table, not on the item.
    img = new_canvas((40, 52, 82), (150, 130, 92))
    circle(img, WIDTH // 2, 280, 120, (232, 204, 150))
    rect(img, 380, 280, 580, 430, (90, 70, 56))
    save_jpeg(img, DEMO_DIR / "bridge-015.jpg")
    items.append({"id": "bridge-015", "type": "image", "file": "bridge-015.jpg"})

    img = new_canvas((58, 70, 48), (178, 190, 150))
    rect(img, 250, 240, 710, 300, (226, 214, 190))
    rect(img, 430, 210, 530, 240, (250, 244, 226))
    save_jpeg(img, DEMO_DIR / "hire-016.jpg")
    items.append({
        "id": "hire-016", "type": "image", "file": "hire-016.jpg",
        "speaker": "Mei",
        "text": "Mei slid the contract over before the coffee cooled.",
    })
    items.append({
        "id": "hire-017", "type": "text", "speaker": "Theo",
        "text": "Start Monday, if that works for you.",
    })
    # The nested decision's two one-line routes, laid out inside the
    # hire span, before its continueAt (hire-018).
    items.append({
        "id": "late-021", "type": "text",
        "text": "They showed at ten, late and grinning.",
    })
    items.append({
        "id": "early-022", "type": "text",
        "text": "They were at the door before the sun was up, so the kettle "
                "went on.",
    })
    items.append({
        "id": "hire-018", "type": "text",
        "text": "Either way, the studio had its week back.",
    })

    img = new_canvas((52, 40, 40), (158, 120, 108))
    rect(img, 0, 380, WIDTH, HEIGHT, (60, 46, 44))
    circle(img, 480, 200, 60, (244, 226, 198))
    save_jpeg(img, DEMO_DIR / "refuse-019.jpg")
    items.append({
        "id": "refuse-019", "type": "image", "file": "refuse-019.jpg",
        "speaker": "Mei",
        "text": "We'll pass this time, Mei said, and she meant it.",
    })
    items.append({
        "id": "refuse-020", "type": "text",
        "text": "An ending card: the studio kept its quiet.",
    })

    img = new_canvas((90, 96, 130), (210, 204, 178))
    circle(img, 700, 130, 64, (254, 246, 214))
    rect(img, 0, 420, WIDTH, HEIGHT, (96, 108, 92))
    save_jpeg(img, DEMO_DIR / "main-023.jpg")
    items.append({
        "id": "main-023", "type": "image", "file": "main-023.jpg",
        "speaker": "Mei",
        "text": "Whatever was decided, the morning moved on.",
    })
    items.append({
        "id": "main-024", "type": "text",
        "text": "And the tape rolled on without an answer.",
    })

    branches = [
        {
            "id": "inner-time", "after": "hire-017",
            "prompt": "When do they meet?",
            "routes": [
                {"id": "late", "label": "Late, over coffee",
                 "start": "late-021", "end": "late-021"},
                {"id": "early", "label": "Early, before the sun",
                 "start": "early-022", "end": "early-022",
                 "result": "return"},
            ],
            "continuingRoute": "late", "continueAt": "hire-018",
        },
        {
            "id": "outer-hire", "after": "bridge-015",
            "prompt": "What does the studio decide?",
            "routes": [
                {"id": "hire", "label": "Offer them the job",
                 "start": "hire-016", "end": "hire-018",
                 "result": "return"},
                {"id": "refuse", "label": "Turn them down",
                 "start": "refuse-019", "end": "refuse-020",
                 "result": "ending"},
            ],
            "continuingRoute": "hire", "continueAt": "main-023",
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

    items = build_image_items()
    items.append(build_animation_item())
    items.append(build_video_item())
    items.extend(build_text_chain_items())
    # The two range items sharing one clip (Phase 9c), after every chain.
    items.extend(build_clip_video_items())
    # The Phase 15 floor chain (~6 s video + two short lines), before the
    # branch demo: the auto walk plays through it, and verify steps 43-44
    # re-enter it to time the floor (auto) and the immediate skip-through.
    items.extend(build_stroll_chain_items())
    # Last: the Phase 13 branch demo — lead-in, decision, nested decision,
    # ending route, aftermath. The `branches` table rides with it.
    branch_items, branches = build_branch_items()
    items.extend(branch_items)
    manifest = {
        "schemaVersion": 1,
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
