#!/usr/bin/env python3
"""Generate fixtures/showcase-demo: the short story the README's
screenshots are taken from (player/scripts/screenshots.mjs).

Usage (from the repo root, Pillow and jsonschema live in the repo venv):

    .venv/bin/python fixtures/build_showcase_demo.py [--out DIR]

`--out` (default fixtures/showcase-demo, gitignored) is deleted and
recreated. It needs no ffmpeg: every item is a picture or a line of text,
drawn with fixtures/build_demo.py's helpers in the demo's style.

fixtures/demo is a guided tour that the scenario suite walks by item id,
so its shape stays as it is. This story is shaped for the branch map
instead: three decisions in a row, so one partial reading can show them
all at once in their different states. The screenshot script reads it
with Play all routes on: at "fork" it plays the shorter route ("by-town",
which returns) and then "by-cliff" (which continues), so "fork" reads 2/2;
at "festival" it plays the shorter route, "take-boat", an ending, and stops
there, so "festival" reads 1/2 and "confession" is not reached.

The output is deterministic, as the demo's is, and the script checks it
with tools/validate_content.py and fails on any warning.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
sys.path.insert(0, str(FIXTURES))
import build_demo  # noqa: E402
from build_demo import WIDTH, HEIGHT, scene  # noqa: E402

OUT_DIR = FIXTURES / "showcase-demo"

CHARACTERS = {
    "Ines": {"nameColor": "#7fd6c2", "textColor": "#f6dca8"},
    "Mei": {"nameColor": "#e8b4d8"},
}

SEA = (40, 70, 96)
SAND = (214, 196, 160)
SUN = (254, 238, 196)


def draw(out: Path) -> None:
    """Every picture of the story, WIDTH x HEIGHT."""
    scene(out, "harbour", (238, 170, 120), (90, 120, 150),
          ("c", (700, 300, 70), SUN),
          ("r", (0, 330, WIDTH, HEIGHT), SEA),
          ("r", (120, 300, 360, 340), (70, 52, 44)),
          ("r", (200, 250, 230, 300), (240, 232, 214)))
    scene(out, "crossroads", (120, 160, 200), (180, 200, 150),
          ("r", (0, 360, WIDTH, HEIGHT), (110, 140, 90)),
          ("r", (440, 360, 520, HEIGHT), SAND),
          ("r", (300, 300, 340, 400), (90, 70, 56)),
          ("r", (260, 290, 380, 310), (232, 220, 190)))
    scene(out, "cliff", (150, 190, 220), (60, 90, 120),
          ("r", (0, 250, 420, HEIGHT), (96, 104, 92)),
          ("r", (420, 380, WIDTH, HEIGHT), SEA),
          ("c", (780, 140, 50), SUN))
    scene(out, "cliff-top", (110, 150, 200), (220, 210, 180),
          ("r", (0, 400, WIDTH, HEIGHT), (96, 120, 80)),
          ("r", (600, 220, 640, 400), (240, 236, 226)),
          ("r", (590, 200, 650, 220), (250, 210, 120)))
    scene(out, "town", (200, 150, 120), (120, 90, 80),
          ("r", (100, 220, 300, 460), (220, 190, 150)),
          ("r", (340, 180, 560, 460), (200, 160, 130)),
          ("r", (600, 240, 840, 460), (230, 204, 168)),
          ("r", (0, 460, WIDTH, HEIGHT), (90, 70, 60)))
    scene(out, "square", (230, 190, 140), (150, 120, 100),
          ("r", (0, 420, WIDTH, HEIGHT), (170, 150, 120)),
          ("c", (480, 380, 90), (120, 160, 190)),
          ("r", (470, 250, 490, 380), (230, 220, 200)))
    scene(out, "lanterns", (30, 30, 60), (80, 50, 70),
          ("c", (200, 160, 26), (250, 190, 90)),
          ("c", (380, 120, 26), (250, 160, 80)),
          ("c", (560, 170, 26), (250, 200, 110)),
          ("c", (740, 130, 26), (250, 170, 90)),
          ("r", (0, 430, WIDTH, HEIGHT), (50, 36, 50)))
    scene(out, "night-boat", (16, 20, 40), (30, 50, 80),
          ("c", (180, 110, 36), (240, 240, 220)),
          ("r", (0, 360, WIDTH, HEIGHT), (20, 34, 60)),
          ("r", (520, 320, 740, 360), (60, 44, 40)))
    scene(out, "pier-night", (20, 24, 50), (60, 60, 90),
          ("r", (0, 380, WIDTH, HEIGHT), (24, 40, 66)),
          ("r", (200, 340, 760, 380), (80, 62, 50)))
    scene(out, "confess", (60, 40, 70), (200, 140, 120),
          ("c", (480, 260, 110), (250, 200, 160)))
    scene(out, "silence", (30, 34, 44), (70, 74, 84),
          ("r", (0, 400, WIDTH, HEIGHT), (40, 44, 54)))
    scene(out, "dawn", (250, 200, 150), (130, 160, 190),
          ("c", (480, 330, 80), SUN),
          ("r", (0, 330, WIDTH, HEIGHT), SEA))


def picture(item_id: str, file: str, text: str | None = None,
            speaker: str | None = None) -> dict:
    item: dict = {"id": item_id, "type": "image", "file": f"{file}.jpg"}
    if speaker is not None:
        item["speaker"] = speaker
    if text is not None:
        item["text"] = text
    return item


def line(item_id: str, text: str, speaker: str | None = None) -> dict:
    item: dict = {"id": item_id, "type": "text", "text": text}
    if speaker is not None:
        item["speaker"] = speaker
    return item


def showcase_manifest(out: Path) -> dict:
    """Draw the pictures into `out` and return the story's manifest."""
    draw(out)
    items = [
        picture("open", "harbour",
                "The ferry leaves at six. Ines said she would be on it.",
                "Mei"),
        line("open-2", "I'm {i}here{/i}. I said I'd {b}come{/b}, didn't I?",
             "Ines"),
        picture("crossroads", "crossroads",
                "Two roads climb from the harbour: one by the cliffs, one "
                "through the town."),
        picture("cliff", "cliff",
                "The cliff path is steep, and the wind carries the gulls.",
                "Ines"),
        line("cliff-2", "Is it always this windy up here?", "Mei"),
        picture("cliff-3", "cliff-top",
                "At the top, the lighthouse. The town lies below."),
        picture("town", "town",
                "The town is shuttered for the festival. Back to the "
                "crossroads.", "Mei"),
        line("town-2", "Everyone must already be at the square.", "Ines"),
        picture("square", "square",
                "The square fills with music as the sun goes down."),
        line("square-2", "Stay for the festival, or catch the last boat?",
             "Mei"),
        picture("stay", "lanterns",
                "Lanterns rise over the square, one by one.", "Ines"),
        line("stay-2", "I'm glad we stayed.", "Mei"),
        picture("leave", "night-boat",
                "The last boat slips out into the dark. The festival goes "
                "on without them."),
        picture("pier", "pier-night",
                "Later, on the empty pier, Mei almost says it.", "Mei"),
        line("pier-2", "Ines... there's something I should tell you.",
             "Mei"),
        picture("tell", "confess", "She tells her.", "Mei"),
        picture("keep", "silence",
                "She says nothing, and the moment passes."),
        picture("dawn", "dawn", "Morning. The ferry is back in the harbour."),
    ]
    branches = [
        {
            "id": "fork", "after": "crossroads",
            "prompt": "Which road?",
            "routes": [
                {"id": "by-cliff", "label": "The cliff path",
                 "start": "cliff", "end": "cliff-3"},
                {"id": "by-town", "label": "Through the town",
                 "start": "town", "end": "town-2", "result": "return"},
            ],
            "continuingRoute": "by-cliff", "continueAt": "square",
        },
        {
            "id": "festival", "after": "square-2",
            "prompt": "Stay for the festival?",
            "routes": [
                {"id": "stay-on", "label": "Stay",
                 "start": "stay", "end": "stay-2"},
                {"id": "take-boat", "label": "Take the last boat",
                 "start": "leave", "end": "leave", "result": "ending"},
            ],
            "continuingRoute": "stay-on", "continueAt": "pier",
        },
        {
            "id": "confession", "after": "pier-2",
            "prompt": "Tell her?",
            "routes": [
                {"id": "tell-her", "label": "Tell her",
                 "start": "tell", "end": "tell"},
                {"id": "say-nothing", "label": "Say nothing",
                 "start": "keep", "end": "keep", "result": "ending"},
            ],
            "continuingRoute": "tell-her", "continueAt": "dawn",
        },
    ]
    return {
        "schemaVersion": 1,
        "storyId": "kinetic-showcase",
        "title": "Last Ferry",
        "width": WIDTH,
        "height": HEIGHT,
        "characters": CHARACTERS,
        "items": items,
        "branches": branches,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the story the README's screenshots show.")
    parser.add_argument("--out", type=Path, default=OUT_DIR,
                        help="folder to delete and recreate "
                             f"(default: {OUT_DIR})")
    out = parser.parse_args().out
    build_demo.reset_dir(out)
    manifest = showcase_manifest(out)
    build_demo.write_manifest(out, manifest)
    build_demo.report(out, build_demo.folder_problems(out, manifest["items"])
                      + build_demo.warning_problems(manifest, out))


if __name__ == "__main__":
    main()
