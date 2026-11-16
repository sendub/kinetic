#!/usr/bin/env python3
"""Generate fixtures/voice-demo: the Kinetic spoken lines demo folder.

Usage (from the repo root, Pillow and jsonschema live in the repo venv):

    .venv/bin/python fixtures/build_voice_demo.py [--out DIR]

`--out` (default fixtures/voice-demo) is deleted and recreated; nothing
else is touched, and a folder holding any subfolder but `voices` is
refused. No external tools: the reference clips are committed inputs.

Unlike the other demos this is a short story, not a guided tour
(docs/plan.md Phase 52, item 6): a stranded traveller, Wren, reaches a
lighthouse cottage in a storm and meets Helen. It shows spoken lines:

- `voices` for Wren, Helen and the Radio and a `narrator`, each a reference clip
  designed with Qwen3-TTS VoiceDesign (fixtures/voices/README.md),
  copied byte for byte from fixtures/voices/ into `voices/` with its
  `.js` script beside it, as tools/cast_voices.py's `pick` ships one;
- the research's six-line test scene (docs/voice-reading.md) word for
  word, Wren and Helen in turn;
- narration (lines with no speaker) before, between and after;
- a thought of Wren's (`thought: true`), spoken in her voice;
- a line from the radio, a fourth voice, a newsreader's bulletin heard
  in the kitchen.

It has no `audio` section, so it is also a voices-only game: the player
mounts sound for the voices alone.

The output is deterministic: two runs produce byte-identical files. The
pictures are drawn with fixtures/build_demo.py's helpers (integer
arithmetic in Pillow, fixed JPEG settings), and the clips and their
scripts are copies of committed bytes.

After generating, the script checks the folder with
tools/validate_content.py and checks that every image is WIDTH x HEIGHT,
as the demo builder does, and also fails on any unreachable item, audio
or voice warning. It exits 1 with one line per problem.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

from build_demo import (HEIGHT, REPO_ROOT, WIDTH, folder_problems, report,
                        scene, write_manifest)

import validate_content  # on sys.path through build_demo
from cast_voices import PHRASE  # tools/, on sys.path through build_demo
from kinetic_extract import audio_format  # put on sys.path by validate_content

VOICE_DEMO_DIR = REPO_ROOT / "fixtures" / "voice-demo"
CLIPS_DIR = REPO_ROOT / "fixtures" / "voices"
VOICES = "voices"

# Speaker -> (clip in fixtures/voices/, the description it was designed
# from). The narrator's key is not a speaker name: it goes to `narrator`.
NARRATOR = "narrator"
CAST = {
    "Wren": ("wren.flac",
             "A young American woman in her twenties with a bright, quick, "
             "friendly voice."),
    "Helen": ("helen.flac",
              "An older British woman in her sixties with a warm, low, "
              "unhurried voice."),
    NARRATOR: ("narrator.flac",
               "A calm, warm middle-aged male narrator with a clear, "
               "measured voice."),
    "Radio": ("radio.flac",
              "A brisk, crisp male radio newsreader in his thirties with a "
              "formal, clear broadcast voice."),
}

# --------------------------------------------------------------------------
# Pictures: a few shapes over a gradient, one per scene
# --------------------------------------------------------------------------

NIGHT = (16, 20, 34)
STORM = (52, 62, 80)
SEA = (28, 40, 56)
STONE = (150, 150, 140)
LAMP = (255, 226, 140)
WARM = (236, 160, 80)
WOOD = (96, 62, 40)


def picture(out: Path, item_id: str, top, bottom, shapes, **fields) -> dict:
    """An image item `<item_id>.jpg` drawn from `shapes` (see build_demo's
    scene), plus `fields` (speaker, text, thought) in that order."""
    scene(out, item_id, top, bottom, *shapes)
    return {"id": item_id, "type": "image", "file": f"{item_id}.jpg",
            **fields}


def line(item_id: str, **fields) -> dict:
    """A text item over the picture before it."""
    return {"id": item_id, "type": "text", **fields}


def story(out: Path) -> list[dict]:
    road = [("r", (0, 400, WIDTH, HEIGHT), SEA),
            ("r", (430, 400, 530, HEIGHT), (70, 70, 74)),
            ("c", (820, 250, 6), LAMP)]
    lighthouse = [("r", (0, 430, WIDTH, HEIGHT), SEA),
                  ("r", (600, 170, 660, 430), STONE),
                  ("r", (590, 140, 670, 175), (60, 60, 64)),
                  ("c", (630, 150, 22), LAMP),
                  ("r", (300, 340, 520, 430), (70, 64, 60)),
                  ("r", (380, 370, 420, 400), WARM)]
    door = [("r", (300, 120, 660, HEIGHT), (80, 72, 66)),
            ("r", (420, 230, 540, HEIGHT), WOOD),
            ("c", (520, 390, 6), (200, 180, 120)),
            ("r", (330, 200, 400, 270), WARM)]
    kitchen = [("r", (0, 420, WIDTH, HEIGHT), WOOD),
               ("r", (80, 220, 300, 420), (60, 44, 36)),
               ("c", (190, 360, 50), WARM),
               ("r", (600, 330, 700, 420), (200, 200, 196)),
               ("r", (640, 300, 660, 330), (200, 200, 196))]
    photo = [("r", (0, 420, WIDTH, HEIGHT), WOOD),
             ("r", (380, 110, 580, 330), (150, 120, 80)),
             ("r", (400, 130, 560, 310), (210, 200, 180)),
             ("c", (480, 190, 30), (120, 100, 90))]
    window = [("r", (0, 0, WIDTH, HEIGHT // 3), STORM),
              ("r", (360, 160, 600, 400), (40, 34, 30)),
              ("r", (372, 172, 588, 388), WARM),
              ("r", (476, 172, 484, 388), (40, 34, 30))]
    return [
        picture(out, "storm-road", NIGHT, STORM, road,
                text="The storm came in off the sea an hour before dark, "
                     "and by nightfall the coast road had vanished under "
                     "it."),
        line("storm-walk",
             text="Wren walked the last two miles with her collar up and "
                  "her phone dead in her pocket, toward the only light on "
                  "the headland."),
        picture(out, "lighthouse", NIGHT, STORM, lighthouse,
                text="High on the old lighthouse a lamp turned slowly "
                     "through the rain. Below it, in a cottage window, a "
                     "fire was burning."),
        line("lighthouse-hope", speaker="Wren", thought=True,
             text="Somebody lives here. Please, let somebody live here."),
        picture(out, "door", (30, 30, 40), (60, 56, 60), door,
                text="She knocked twice. For a long moment there was only "
                     "the wind."),
        line("door-hello", speaker="Wren",
             text="Hello? Is anyone home? I didn't think anybody still "
                  "lived out here."),
        line("door-forty", speaker="Helen",
             text="Forty years this spring. You'd better come inside "
                  "before the storm does."),
        picture(out, "kitchen", (60, 40, 30), (120, 80, 50), kitchen,
                speaker="Wren",
                text="I'm so sorry to barge in. My car died two miles back, "
                     "and my phone's completely useless."),
        line("kitchen-kettle", speaker="Helen",
             text="Phones usually are, out here. Sit by the fire, love. The "
                  "kettle's already on."),
        line("kitchen-expecting", speaker="Wren",
             text="Wait... the kettle's on? Were you expecting someone "
                  "tonight?"),
        line("kitchen-you", speaker="Helen",
             text="Not someone. You. Your grandmother always said you'd "
                  "find your way here, one day."),
        line("kitchen-cups",
             text="Helen set two cups on the table, as if she had known all "
                  "along there would be two."),
        line("kitchen-radio", speaker="Radio",
             text="Gales along the whole north coast tonight. Stay indoors, "
                  "keep away from the cliffs, and keep your lamps lit."),
        line("kitchen-silence",
             text="Helen turned the radio off. Wren looked from the cups to "
                  "the old woman, and then to the photograph above the "
                  "fire."),
        picture(out, "photo", (60, 40, 30), (110, 76, 50), photo,
                text="A young woman laughed out of the frame, standing on "
                     "this very doorstep with the lighthouse behind her."),
        line("photo-wren", speaker="Wren",
             text="That's her. That's my grandmother. How do you know her?"),
        line("photo-helen", speaker="Helen",
             text="Drink your tea first, love. It's a long story, and we've "
                  "got all night."),
        picture(out, "window", NIGHT, (40, 34, 30), window,
                text="Outside, the storm went on without them. Inside, the "
                     "kettle sang, and Helen began to tell it."),
    ]


# --------------------------------------------------------------------------
# Voices: the committed clips, copied with their scripts
# --------------------------------------------------------------------------


def ship_voices(out: Path) -> tuple[dict[str, dict], dict]:
    """Copy each clip into out/voices/ with its script; the manifest's
    `voices` and `narrator`."""
    (out / VOICES).mkdir()
    voices: dict[str, dict] = {}
    narrator: dict = {}
    for name, (clip, description) in CAST.items():
        file = f"{VOICES}/{clip}"
        shutil.copyfile(CLIPS_DIR / clip, out / file)
        audio_format.write_script(out, file)
        voice = {"file": file, "text": PHRASE, "description": description}
        if name == NARRATOR:
            narrator = voice
        else:
            voices[name] = voice
    return voices, narrator


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def reset_dir(out: Path) -> None:
    """Delete and recreate `out`. A build holds one subfolder, `voices`,
    with files only; a folder holding anything else is not a build:
    refuse to delete it."""
    if out.is_dir():
        foreign = [p for p in out.iterdir() if p.is_dir()
                   and (p.name != VOICES
                        or any(q.is_dir() for q in p.iterdir()))]
        if foreign:
            sys.exit(f"{out}: holds {foreign[0].name}/, so it is not a "
                     "voice demo build; not deleting it")
        shutil.rmtree(out)
    out.mkdir(parents=True)


def warnings(manifest: dict, out: Path) -> list[str]:
    """Every validator warning, which the demo must not have."""
    return (validate_content.reach_warnings(manifest)
            + validate_content.audio_warnings(manifest, out)
            + validate_content.voice_warnings(manifest))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the Kinetic spoken lines demo folder.")
    parser.add_argument("--out", type=Path, default=VOICE_DEMO_DIR,
                        help="folder to delete and recreate "
                             f"(default: {VOICE_DEMO_DIR})")
    out = parser.parse_args().out
    reset_dir(out)

    items = story(out)
    voices, narrator = ship_voices(out)
    manifest = {
        "schemaVersion": 1,
        "storyId": "kinetic-voice-demo",
        "title": "Voice demo",
        "width": WIDTH,
        "height": HEIGHT,
        "voices": voices,
        "narrator": narrator,
        "items": items,
    }

    write_manifest(out, manifest)
    report(out, folder_problems(out, items) + warnings(manifest, out))


if __name__ == "__main__":
    main()
