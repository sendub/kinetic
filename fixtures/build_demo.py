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
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(VIDEO_FPS), "-i", "-",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-threads", "1",
        "-fflags", "+bitexact", "-flags", "+bitexact",
        "-map_metadata", "-1", "-map_chapters", "-1",
        "-movflags", "+faststart",
        str(mp4),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    band_w = 120
    for n in range(VIDEO_FRAMES):
        img = new_canvas((12, 24, 40), (34, 52, 74))
        x = (n * 11) % (WIDTH - band_w)
        rect(img, x, 150, x + band_w, 390, (90, 200, 170))
        proc.stdin.write(img.tobytes())
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit(f"ffmpeg failed with exit code {proc.returncode}")

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(mp4)],
        check=True, capture_output=True, text=True,
    )
    duration = round(float(probe.stdout.strip()), 3)

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


def build_text_chain_items() -> list[dict]:
    """Items that exercise the `text` type (docs/content-format.md §Text items).

    A `text` item carries no media fields; it shows the visual of the nearest
    earlier media-bearing item, which keeps playing/looping beneath a chain of
    them. Returned in manifest order to append after the video item:

    - two dialogue lines over the looping video (intro-006);
    - a still (pier-009) followed by two dialogue lines.
    """
    # Dialogue chain over the video: two distinct speakers/lines, no media.
    items: list[dict] = [
        {"id": "line-007", "type": "text", "speaker": "Mei",
         "text": "The street glowed under the awning."},
        {"id": "line-008", "type": "text",
         "text": "Neither of us spoke for a while."},
    ]

    # Dialogue chain over one still: a bare image (no overlaid text), then
    # two distinct lines drawn over it.
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
        "id": "line-011", "type": "text",
        "text": "We stacked the rest ourselves, and called it enough.",
    })

    return items


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
    manifest = {
        "schemaVersion": 1,
        "width": WIDTH,
        "height": HEIGHT,
        "items": items,
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
