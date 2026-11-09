#!/usr/bin/env python3
"""Generate fixtures/audio-demo: the Kinetic sound demo content folder.

Usage (from the repo root, Pillow and jsonschema live in the repo venv):

    .venv/bin/python fixtures/build_audio_demo.py [--out DIR]

`--out` (default fixtures/audio-demo) is deleted and recreated; nothing
else is touched, and a folder holding subfolders is refused, as
fixtures/build_demo.py does. External tools: ffmpeg and ffprobe on PATH.

Like fixtures/demo it is a guided tour, not a story (docs/plan.md
Phase 47, item 3): every line of text says what the reader should hear
right now, and where it helps, what to try. Sections, in order:

- intro card (silence);
- music: a tune starts; it carries over a line that sets nothing; a
  4 s crossfade to a second tune (`fadeMs` 4000); a fanfare that plays
  once (`loop: false`); a track that starts partway and loops from an
  earlier point (`startSeconds` 6, `loopStartSeconds` 3: groups of three
  beeps, then four, then back to two, never the single beeps);
  `music: null` with a 2 s fade, so no music plays until the decision;
- ambience: rain and hum start together, both carry over a line, the
  rain stops while the hum plays on (the set shrinks), then `[]` stops
  the hum;
- one-shots: a double knock 1.5 s late (`delayMs`); a siren cut by a
  bell on one `channel`; the same two with no channel, overlapping;
- voice: two speakers' chirp patterns on a text chain, then a short
  line whose 8.4 s voice outlasts its text, so auto-forward waits;
- a decision: Route 1 (the continuing route) sets warm music, Route 2
  (`result: "continue"`) a cold trill, and both join at `continueAt`, an
  item that sets no music, so it plays the music of the route read last;
- a video playing seconds 2-8 of an 8 s clip, looping from 4, with a
  `videoSound` track cut from the same timeline (a click as the bar
  hits each wall, a tone per colour) that ducks the music to 0.3, under
  a text chain;
- an item that sets both music and ambience, so it sounds the same
  after either route, then the end.

Tracks are a mix of every container the validator takes without a
warning: Opus and Vorbis in WebM, AAC in M4A, MP3 and WAV, all mono at
48 kHz, made from ffmpeg's `aevalsrc` and `anoisesrc` (no speech can be
synthesised, so voices are chirps). Each track's `durationSeconds` is its
decoded length, samples over rate, as kinetic-media measures it. The M4A
tracks are 8 s, a whole number of 1024-sample AAC frames, so no encoder
padding is decoded with them.

The output is deterministic: two runs produce byte-identical files.
Pictures and the video come from fixtures/build_demo.py's helpers; the
audio is generated from fixed expressions and a fixed noise seed and
encoded single-threaded with bitexact flags and no metadata.

After generating, the script checks the folder with
tools/validate_content.py and checks that every image is WIDTH x HEIGHT,
as the demo builder does, and also fails on any audio warning (an unused
track or an Ogg file). It exits 1 with one line per problem.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from build_demo import (CLIP_QUARTERS, HEIGHT, REPO_ROOT, VIDEO_FPS, WIDTH,
                        card, encode, extract_poster, folder_problems,
                        new_canvas, rect, report, reset_dir, scene,
                        write_manifest)

import validate_content  # on sys.path through build_demo

AUDIO_DEMO_DIR = REPO_ROOT / "fixtures" / "audio-demo"
SAMPLE_RATE = 48000

# --------------------------------------------------------------------------
# Audio: lavfi sources, deterministic encodes, decoded durations
# --------------------------------------------------------------------------

# Output arguments per codec, with its container's extension.
CODECS = {
    "opus": (".webm", ["-c:a", "libopus", "-b:a", "48k"]),
    "vorbis": (".webm", ["-c:a", "libvorbis", "-q:a", "3"]),
    "aac": (".m4a", ["-c:a", "aac", "-b:a", "96k"]),
    "mp3": (".mp3", ["-c:a", "libmp3lame", "-b:a", "96k",
                     "-id3v2_version", "0"]),
    "wav": (".wav", ["-c:a", "pcm_s16le"]),
}


def tone(expr: str, seconds: float) -> str:
    """A lavfi source evaluating `expr` (ffmpeg expression syntax, time
    `t`) for `seconds`."""
    return f"aevalsrc=exprs='{expr}':s={SAMPLE_RATE}:d={seconds}"


def pick(index: str, values: list[float]) -> str:
    """An expression for values[index], `index` an integer expression."""
    expr = str(values[-1])
    for i in range(len(values) - 2, -1, -1):
        expr = f"if(eq({index},{i}),{values[i]},{expr})"
    return expr


def notes(freqs: list[float], note: float, amp: float,
          harmonics: tuple[float, ...] = (1.0,), decay: float = 0) -> str:
    """A looping run of `note`-second notes cycling through `freqs`. Each
    note swells in and out, so a note change, and the track's own loop
    when it holds whole cycles, never clicks."""
    timbre = "+".join(f"{weight}*sin({k + 1}*2*PI*ld(1)*ld(0))"
                      for k, weight in enumerate(harmonics))
    env = f"sin(PI*ld(0)/{note})"
    if decay:
        env += f"*exp(-{decay}*ld(0))"
    return (f"st(0,mod(t,{note}));st(2,mod(floor(t/{note}),{len(freqs)}));"
            f"st(1,{pick('ld(2)', freqs)});{amp}*{env}*({timbre})")


def chirps(period: float, length: float, amp: float, rising: str,
           falling: str | None = None) -> str:
    """A chirp of `length` s every `period` s. `rising` and `falling` are
    phase polynomials in the chirp's own time ld(0); with `falling`,
    chirps alternate between the two."""
    phase = rising if falling is None else \
        f"if(mod(floor(t/{period}),2),{falling},{rising})"
    return (f"st(0,mod(t,{period}));"
            f"if(lt(ld(0),{length}),"
            f"{amp}*sin(PI*ld(0)/{length})*sin(2*PI*({phase})),0)")


# Groups of 1, 2, 3, then 4 beeps, one group a second, 3 s per block,
# each block higher: the start and loop points land on block edges.
STEPS = ("st(0,floor(t/3));st(1,mod(t,1));"
         "st(2,floor(ld(1)/0.15));st(3,mod(ld(1),0.15));"
         "if(lt(ld(2),ld(0)+1)*lt(ld(3),0.1),"
         "0.3*sin(PI*ld(3)/0.1)*sin(2*PI*"
         + pick("ld(0)", [330.0, 392.0, 494.0, 587.0]) + "*ld(3)),0)")

# Three short rising notes, then a long ringing top note.
FANFARE = ("if(lt(t,0.75),"
           "st(0,mod(t,0.25));"
           "0.35*sin(PI*ld(0)/0.25)*sin(2*PI*"
           "if(lt(t,0.25),523.25,if(lt(t,0.5),659.25,783.99))*ld(0)),"
           "st(0,t-0.75);"
           "0.4*min(1,ld(0)*40)*exp(-1.2*ld(0))"
           "*(sin(2*PI*1046.5*ld(0))+0.3*sin(2*PI*1568*ld(0))))")

# The video's sound, on the video's timeline: a tone per 2 s colour
# (fading 20 ms either side of each change) and a click every second,
# when the bar hits a wall.
CLOCK = ("st(0,floor(t/2));st(1,mod(t,2));st(2,mod(t,1));"
         "0.15*min(1,min(ld(1)*50,(2-ld(1))*50))*sin(2*PI*"
         + pick("ld(0)", [196.0, 262.0, 330.0, 440.0]) + "*ld(1))"
         "+0.6*exp(-120*ld(2))*sin(2*PI*2500*ld(2))")

# (track id, codec, lavfi source, extra -af filters, extra track fields)
TRACKS = [
    ("calm", "aac", tone(notes(
        [220.0, 277.18, 329.63, 440.0, 329.63, 277.18, 246.94, 196.0],
        0.5, 0.3, (1.0, 0.25)), 8), None, {}),
    ("bright", "opus", tone(notes(
        [523.25, 659.25, 783.99, 1046.5, 783.99, 659.25],
        0.2, 0.22, (1.0, 0.5, 0.25)), 7.2), None, {}),
    ("steps", "vorbis", tone(STEPS, 12), None,
     {"startSeconds": 6, "loopStartSeconds": 3}),
    ("fanfare", "mp3", tone(FANFARE, 3), "afade=t=out:st=2.7:d=0.3",
     {"loop": False}),
    ("rain", "opus",
     f"anoisesrc=duration=6:color=pink:sample_rate={SAMPLE_RATE}"
     ":amplitude=0.6:seed=7", "lowpass=f=2500", {"volume": 0.5}),
    ("hum", "wav", tone(
        "0.18*sin(2*PI*110*t)+0.1*sin(2*PI*220*t)+0.05*sin(2*PI*330*t)", 4),
     None, {}),
    ("knock", "wav", tone(
        "st(0,mod(t,0.22));if(lt(t,0.44),exp(-30*ld(0))"
        "*(0.7*sin(2*PI*140*ld(0))"
        "+0.25*exp(-150*ld(0))*sin(2*PI*1700*ld(0))),0)", 0.6), None, {}),
    ("siren", "mp3", tone("0.3*sin(2*PI*750*t-250*cos(2*PI*t))", 6),
     "afade=t=in:d=0.05,afade=t=out:st=5.8:d=0.2", {}),
    ("bell", "vorbis", tone(
        "min(1,t*200)*(0.35*exp(-1.5*t)*sin(2*PI*1318.5*t)"
        "+0.18*exp(-2.5*t)*sin(2*PI*2637*t)"
        "+0.09*exp(-4*t)*sin(2*PI*3955.5*t))", 3),
     "afade=t=out:st=2.7:d=0.3", {}),
    ("mei-1", "opus", tone(chirps(
        0.4, 0.25, 0.35, "600*ld(0)+1200*ld(0)*ld(0)"), 1.2), None, {}),
    ("theo-1", "mp3", tone(chirps(
        0.55, 0.35, 0.4, "400*ld(0)-285.714*ld(0)*ld(0)"), 1.1), None, {}),
    ("mei-long", "opus", tone(chirps(
        0.4, 0.25, 0.35, "600*ld(0)+1200*ld(0)*ld(0)",
        "1200*ld(0)-1200*ld(0)*ld(0)"), 8.4), None, {}),
    ("warm", "aac", tone(notes(
        [130.81, 164.81, 196.0, 164.81], 1.0, 0.4, (1.0, 0.5, 0.2),
        decay=2.5), 8), None, {}),
    ("cold", "mp3", tone(notes(
        [880.0, 932.33], 0.125, 0.18, (1.0, 0.3)), 4), None, {"volume": 0.6}),
    ("clock", "aac", tone(CLOCK, 8), None, {}),
]


def encode_audio(path: Path, source: str, codec: str,
                 filters: str | None) -> None:
    """Render a lavfi source to mono 48 kHz and encode it. Single thread,
    bitexact flags and no metadata make two runs write the same bytes."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
           "-f", "lavfi", "-i", source]
    if filters:
        cmd += ["-af", filters]
    cmd += ["-ac", "1", "-ar", str(SAMPLE_RATE), *CODECS[codec][1],
            "-threads", "1", "-fflags", "+bitexact", "-flags", "+bitexact",
            "-map_metadata", "-1", "-map_chapters", "-1", str(path)]
    subprocess.run(cmd, check=True)


def decoded_duration(path: Path) -> float:
    """Decoded samples over sample rate, 6 decimals: what a decoder makes
    of the file, which container headers can misstate."""
    rate = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=sample_rate", "-of", "csv=p=0", str(path)],
        check=True, capture_output=True, text=True).stdout
    samples = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-map", "0:a:0", "-ac", "1", "-c:a", "pcm_u8", "-f", "u8", "-"],
        check=True, capture_output=True).stdout
    return round(len(samples) / int(rate), 6)


def make_tracks(out: Path) -> dict[str, dict]:
    """Encode every track into `out`; the manifest's `audio.tracks`."""
    tracks: dict[str, dict] = {}
    for track_id, codec, source, filters, fields in TRACKS:
        name = track_id + CODECS[codec][0]
        encode_audio(out / name, source, codec, filters)
        tracks[track_id] = {"file": name,
                            "durationSeconds": decoded_duration(out / name),
                            **fields}
    return tracks


# --------------------------------------------------------------------------
# Content: one section per sound feature, every line says what to hear
# --------------------------------------------------------------------------

# (top, bottom, accent) per section; the accent dot moves along with each
# picture, so neighbouring pictures differ.
MUSIC = ((24, 30, 64), (70, 90, 150), (240, 200, 110))
AMBIENCE = ((20, 40, 44), (70, 110, 110), (180, 220, 230))
ONE_SHOTS = ((50, 20, 20), (130, 60, 50), (250, 210, 120))
VOICE = ((40, 24, 56), (110, 70, 120), (250, 190, 210))
BRANCH = ((30, 36, 30), (100, 120, 90), (230, 230, 170))
WARM = ((70, 36, 16), (190, 120, 60), (255, 220, 150))
COLD = ((14, 30, 60), (90, 140, 200), (220, 240, 255))
PIN = ((30, 30, 40), (90, 100, 120), (250, 240, 200))


def picture(out: Path, item_id: str, look: tuple, step: int,
            **fields) -> dict:
    """An image item: the section's gradient with its accent dot at
    `step`, plus `fields` (speaker, text, audio) in that order."""
    top, bottom, accent = look
    scene(out, item_id, top, bottom,
          ("c", (160 + step * 160, HEIGHT // 2, 60), accent))
    return {"id": item_id, "type": "image", "file": f"{item_id}.jpg",
            **fields}


def line(item_id: str, **fields) -> dict:
    """A text item over the visual before it."""
    return {"id": item_id, "type": "text", **fields}


def section_intro(out: Path) -> list[dict]:
    return [card(
        out, "intro-title",
        "Kinetic audio demo. Each line says what you should hear right "
        "now; here, silence. Space shows the next item, the mouse wheel "
        "goes back, and v turns sound on or off.",
    )]


def section_music(out: Path) -> list[dict]:
    return [
        card(out, "music-title",
             "Next: music. Still silence: no music has started yet."),
        picture(out, "music-start", MUSIC, 0,
                text="Music fades in: a calm, low tune of slow notes, "
                     "looping.",
                audio={"music": "calm"}),
        line("music-carry",
             text="The same tune plays on. This line sets no music, so the "
                  "music carries over."),
        picture(out, "music-crossfade", MUSIC, 1,
                text="A slow 4-second crossfade: the low tune fades out as "
                     "a brighter, faster tune fades in.",
                audio={"music": "bright", "fadeMs": 4000}),
        # A short fade, so the fanfare's first three notes are not lost in
        # the default 1 s fade-in.
        picture(out, "music-once", MUSIC, 2,
                text="The tune gives way to a fanfare, ta-ta-ta-taaa, that "
                     "plays once and stops by itself: this track does not "
                     "loop. Then silence.",
                audio={"music": "fanfare", "fadeMs": 250}),
        picture(out, "music-partway", MUSIC, 3,
                text="Groups of beeps. The track starts partway, on groups "
                     "of three, then four, then loops back to two. You "
                     "never hear single beeps.",
                audio={"music": "steps"}),
        # Music stays off until the routes, so a wheel step back onto any
        # line before them is silent too.
        picture(out, "music-stop", MUSIC, 4,
                text="The beeps fade out over 2 seconds and stop. No music "
                     "from here until the decision.",
                audio={"music": None, "fadeMs": 2000}),
    ]


def section_ambience(out: Path) -> list[dict]:
    return [
        card(out, "amb-title",
             "Next: ambience, loops that play under everything. Silence "
             "here: no music, no loops yet."),
        picture(out, "amb-start", AMBIENCE, 0,
                text="Two loops start together: a soft hiss of rain and a "
                     "low, steady hum.",
                audio={"ambience": ["rain", "hum"]}),
        line("amb-carry",
             text="Rain and hum play on under this line, which sets "
                  "nothing."),
        picture(out, "amb-shrink", AMBIENCE, 1,
                text="The rain fades out. The hum plays on without a break, "
                     "because it is in both sets.",
                audio={"ambience": ["hum"]}),
        picture(out, "amb-stop", AMBIENCE, 2,
                text="The hum fades out too: an empty set stops every loop. "
                     "Silence.",
                audio={"ambience": []}),
    ]


def section_one_shots(out: Path) -> list[dict]:
    return [
        card(out, "sfx-title",
             "Next: one-shots, sounds that play once on their line. "
             "Silence here."),
        picture(out, "sfx-delay", ONE_SHOTS, 0,
                text="Wait: a double knock comes 1.5 seconds after this "
                     "line appears. Press Space before then and it never "
                     "plays.",
                audio={"sfx": [{"track": "knock", "delayMs": 1500}]}),
        picture(out, "sfx-channel", ONE_SHOTS, 1,
                text="A siren starts. After 2 seconds a bell rings and the "
                     "siren stops dead: both are on one channel, so the "
                     "bell cuts it off.",
                audio={"sfx": [
                    {"track": "siren", "channel": "alarm"},
                    {"track": "bell", "delayMs": 2000, "channel": "alarm"},
                ]}),
        picture(out, "sfx-overlap", ONE_SHOTS, 2,
                text="The same siren and bell with no channel: the bell "
                     "rings at 2 seconds while the siren keeps going to its "
                     "end, at 6.",
                audio={"sfx": [
                    {"track": "siren"},
                    {"track": "bell", "delayMs": 2000},
                ]}),
    ]


def section_voice(out: Path) -> list[dict]:
    return [
        card(out, "voice-title",
             "Next: voice lines. Speech cannot be made here, so each voice "
             "is a pattern of chirps. Silence on this card."),
        picture(out, "voice-mei", VOICE, 0, speaker="Mei",
                text="Mei's voice: three quick, high, rising chirps.",
                audio={"voice": "mei-1"}),
        line("voice-theo", speaker="Theo",
             text="Theo's voice: two slower, lower, falling chirps.",
             audio={"voice": "theo-1"}),
        # The voice (8.4 s) outlasts this line's hold (about 6 s at the
        # default speed), so auto-forward waits for the voice.
        line("voice-long", speaker="Mei",
             text="Mei chirps for about 8 seconds here. With auto-forward "
                  "on (press a), the next line waits for her.",
             audio={"voice": "mei-long"}),
        line("voice-after",
             text="No voice here. A voice belongs to its line: if you "
                  "pressed Space during the chirps, they stopped at once."),
    ]


def section_branch(out: Path) -> tuple[list[dict], list[dict]]:
    """Two routes that set different music, both joining at one item
    that sets none: Route 1 continues, Route 2's result is "continue"."""
    items = [
        card(out, "branch-title",
             "Next: a decision. Each route sets its own music, and both "
             "lead into one shared scene that sets none. Silence here."),
        picture(out, "branch-ask", BRANCH, 0,
                text="Pick a route: Route 1 plays slow, warm bell notes, "
                     "Route 2 a fast, high trill. Silence until you pick."),
        picture(out, "route-warm", WARM, 1,
                text="Route 1: warm music, slow, low bell notes, fades in.",
                audio={"music": "warm"}),
        line("route-warm-2",
             text="Still the warm bells. Route 1 ends here and goes on to "
                  "the shared scene."),
        picture(out, "route-cold", COLD, 2,
                text="Route 2: cold music, a fast, high trill, fades in.",
                audio={"music": "cold"}),
        line("route-cold-2",
             text="Still the trill. Route 2 ends here and goes on to the "
                  "shared scene too."),
        picture(out, "branch-join", BRANCH, 3,
                text="This shared scene sets no music, so you hear the "
                     "route you read last: bells after Route 1, the trill "
                     "after Route 2. Wheel back, pick the other route, and "
                     "come back to hear it change."),
    ]
    branches = [{
        "id": "music-choice", "after": "branch-ask",
        "prompt": "Which route's music?",
        "routes": [
            {"id": "warm", "label": "Route 1: slow, warm bells",
             "start": "route-warm", "end": "route-warm-2"},
            {"id": "cold", "label": "Route 2: a fast, high trill",
             "start": "route-cold", "end": "route-cold-2",
             "result": "continue"},
        ],
        "continuingRoute": "warm", "continueAt": "branch-join",
    }]
    return items, branches


VIDEO_SECONDS = 8
BAR_WIDTH = 60
WALL = 40
FLASH_FRAMES = 3


def sync_frame(n: int):
    """Frame `n` of the synced clip: CLIP_QUARTERS' colour per 2 s, and a
    bar that crosses in 1 s and hits a wall on every whole second (left on
    even seconds), where the clock track clicks. The wall it hits flashes
    for FLASH_FRAMES frames."""
    top, bottom = CLIP_QUARTERS[min(n // (2 * VIDEO_FPS), 3)]
    img = new_canvas(top, bottom)
    phase = n % (2 * VIDEO_FPS)
    travel = phase if phase <= VIDEO_FPS else 2 * VIDEO_FPS - phase
    x = WALL + travel * (WIDTH - 2 * WALL - BAR_WIDTH) // VIDEO_FPS
    lit, dim = (255, 250, 220), (70, 70, 80)
    rect(img, 0, 120, WALL - 1, 420,
         lit if phase < FLASH_FRAMES else dim)
    rect(img, WIDTH - WALL, 120, WIDTH - 1, 420,
         lit if 0 <= phase - VIDEO_FPS < FLASH_FRAMES else dim)
    rect(img, x, 160, x + BAR_WIDTH - 1, 380, (236, 206, 120))
    return img


def section_video(out: Path) -> list[dict]:
    """A range of the clip with a loop restart, its synced sound ducking
    the music, under a text chain."""
    mp4 = out / "video-sync.mp4"
    duration = encode(mp4, (sync_frame(n)
                            for n in range(VIDEO_SECONDS * VIDEO_FPS)))
    extract_poster(mp4, 2.0, out / "video-sync.poster.jpg")
    return [
        card(out, "video-title",
             "Next: a video with its own sound. Here you still hear the "
             "music of the route you read last."),
        {"id": "video-sync", "type": "video", "file": "video-sync.mp4",
         "poster": "video-sync.poster.jpg", "durationSeconds": duration,
         "startSeconds": 2.0, "endSeconds": 8.0, "loopStartSeconds": 4.0,
         "text": "The video's sound: a click each time the bar hits a wall, "
                 "and a tone that changes with the colour. The music dips "
                 "while it plays.",
         "audio": {"videoSound": {"track": "clock", "duck": 0.3}}},
        line("video-sync-2",
             text="It starts at 2 seconds on violet, runs through rust to "
                  "blue, then loops from rust. Green, with the lowest tone, "
                  "never plays."),
        line("video-sync-3",
             text="Clip and sound loop on together under these lines, each "
                  "click on a wall hit. The music stays low meanwhile."),
    ]


def section_end(out: Path) -> list[dict]:
    return [
        picture(out, "pin", PIN, 2,
                text="This scene sets both music and ambience, so it sounds "
                     "the same whichever route you took: the calm tune "
                     "again, with rain.",
                audio={"music": "calm", "ambience": ["rain"],
                       "fadeMs": 3000}),
        line("end",
             text="The end, still with the calm tune and rain. Wheel back "
                  "to any line: after a moment its music and ambience "
                  "play, but one-shots stay quiet. Press e to come back."),
    ]


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate the Kinetic sound demo content folder.")
    parser.add_argument("--out", type=Path, default=AUDIO_DEMO_DIR,
                        help="folder to delete and recreate "
                             f"(default: {AUDIO_DEMO_DIR})")
    out = parser.parse_args().out
    reset_dir(out)

    items: list[dict] = []
    items += section_intro(out)
    items += section_music(out)
    items += section_ambience(out)
    items += section_one_shots(out)
    items += section_voice(out)
    branch_items, branches = section_branch(out)
    items += branch_items
    items += section_video(out)
    items += section_end(out)
    manifest = {
        "schemaVersion": 1,
        "storyId": "kinetic-audio-demo",
        "title": "Kinetic audio demo",
        "width": WIDTH,
        "height": HEIGHT,
        "audio": {"tracks": make_tracks(out)},
        "items": items,
        "branches": branches,
    }

    write_manifest(out, manifest)
    report(out, folder_problems(out, items)
           + validate_content.audio_warnings(manifest))


if __name__ == "__main__":
    main()
