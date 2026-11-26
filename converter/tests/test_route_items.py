"""Routes may hold any item (docs/plan.md Phase 60 item 8b).

A menu whose route shows an ATL animation or plays a video becomes a
decision, as one holding only pictures and lines does: the format sets
no type limit on a route's items. A `text` item shows the nearest earlier
media item in ARRAY order, so a route after the first whose first line is
said over the visual on screen at the menu would show what the route
before it last showed: that line's item repeats the menu's visual instead
(an animation replayed, a video from its start, an animation that holds
its last frame as that frame's picture). The first route needs no repeat:
the lead-in's visual is the nearest earlier one.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `--strict` validation with nothing
printed, `kinetic routes` counts, and `kinetic check --steps all` walking
to the story's end.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from PIL import Image

from kinetic_extract import media_tools
from test_jump_menus import (check_folder, detection, extract,
                             menu_reports, shape)

PICTURE = ["-f", "lavfi", "-i", "testsrc=size=64x36:rate=10:duration=1"]
TONE = ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=22050:"
        "duration=1"]
H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p"]

# Frames and a second picture the size of test_jump_menus' bg.png.
COLOURS = {"f1.png": (200, 30, 30), "f2.png": (30, 200, 30),
           "f3.png": (30, 30, 200), "other.png": (120, 120, 0)}

ATL = ('image glow:\n'                    # loops
       '    "f1.png"\n    pause 0.25\n'
       '    "f2.png"\n    pause 0.25\n'
       '    repeat\n'
       'image once:\n'                    # plays once, holds f3
       '    "f2.png"\n    pause 0.25\n'
       '    "f3.png"\n    pause 0.25\n')
CLIP = 'image clip = Movie(play="clip.mp4")\n'


def ffmpeg(out: Path, args: list[str]) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run([*media_tools.ffmpeg_cmd(), "-y", *args,
                           str(out)], capture_output=True, text=True,
                          check=False)
    assert proc.returncode == 0 and out.is_file(), proc.stderr


def assets(tmp_path: Path, video: bool = False) -> None:
    """The frames, a second picture and (``video``) a 1 s clip with its
    own sound and a one-shot, beside test_jump_menus' bg.png."""
    game = tmp_path / "proj" / "game"
    (game / "images").mkdir(parents=True, exist_ok=True)
    for name, colour in COLOURS.items():
        Image.new("RGB", (32, 18), colour).save(game / "images" / name)
    if video:
        ffmpeg(game / "clip.mp4", [*PICTURE, *TONE, *H264, "-c:a", "aac",
                                   "-shortest"])
        ffmpeg(game / "ding.ogg", [*TONE, "-c:a", "libvorbis"])


def by_text(manifest: dict, text: str) -> dict[str, Any]:
    (item,) = [i for i in manifest["items"] if i.get("text") == text]
    return item


def shown(manifest: dict, text: str) -> dict[str, Any]:
    """The item whose visual the player draws at the item carrying
    ``text``: itself, or for a `text` item the nearest earlier item that
    is not `text`, in array order (player machine.visualIndexFor)."""
    items = manifest["items"]
    k = items.index(by_text(manifest, text))
    while items[k]["type"] == "text":
        k -= 1
    return items[k]


def picture(item: dict[str, Any]) -> Any:
    """What a media item shows: its file, or an animation's frames."""
    return item.get("frames") or item["file"]


def kinds(manifest: dict) -> list[tuple[str, str | None]]:
    return [(i["type"], i.get("text")) for i in manifest["items"]]


def test_a_route_showing_an_atl_animation_is_a_decision(
        tmp_path: Path) -> None:
    assets(tmp_path)
    out, manifest, ledger = extract(tmp_path, ATL + (
        'label start:\n    scene bg\n    "Lead."\n'
        '    menu "Look?":\n'
        '        "Watch":\n'
        '            show glow\n'
        '            "It glows."\n'
        '            "Still glowing."\n'
        '        "Leave":\n'
        '            "You leave."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    assert detection(ledger)[0]["result"] == "detected"
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Watch", "It glows.", "Still glowing.", "continue"),
                   ("Leave", "You leave.", "You leave.", "continue")],
        "continuing": "Leave", "continueAt": "After."}]
    glow = by_text(manifest, "It glows.")
    assert glow["type"] == "animation" and len(glow["frames"]) == 2
    assert shown(manifest, "Still glowing.") is glow
    # "You leave." is said over bg, not over the other route's glow.
    assert picture(shown(manifest, "You leave.")) == picture(
        by_text(manifest, "Lead."))
    check_folder(tmp_path, out, manifest)


def test_a_route_playing_a_video_is_a_decision(tmp_path: Path) -> None:
    assets(tmp_path, video=True)
    out, manifest, ledger = extract(tmp_path, CLIP + (
        'label start:\n    scene bg\n    "Lead."\n'
        '    menu "Watch the clip?":\n'
        '        "Yes":\n'
        '            scene clip\n'
        '            "It plays."\n'
        '            play sound "ding.ogg"\n'
        '        "No":\n'
        '            "Not now."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    assert shape(manifest) == [{
        "after": "Lead.",
        "routes": [("Yes", "It plays.", "It plays.", "continue"),
                   ("No", "Not now.", "Not now.", "continue")],
        "continuing": "No", "continueAt": "After."}]
    clip = by_text(manifest, "It plays.")
    assert clip["type"] == "video"
    # The clip's own sound plays with it; the sound after the route's
    # last line stays on that line's item, the video.
    assert clip["audio"]["videoSound"]["track"] == "clip"
    assert clip["audio"]["sfx"][0]["track"] == "ding"
    assert picture(shown(manifest, "Not now.")) == picture(
        by_text(manifest, "Lead."))
    check_folder(tmp_path, out, manifest)


def test_a_route_s_first_line_over_the_lead_in_s_animation(
        tmp_path: Path) -> None:
    assets(tmp_path)
    out, manifest, ledger = extract(tmp_path, ATL + (
        'label start:\n    scene bg\n    show glow\n    "It glows."\n'
        '    menu "Which?":\n'
        '        "Stay":\n'
        '            "Still here."\n'
        '        "Elsewhere":\n'
        '            scene other\n'
        '            "Somewhere else."\n'
        '        "Watch":\n'
        '            "Watching the glow."\n'
        '            "Watching on."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    glow = by_text(manifest, "It glows.")
    # The first route's line inherits the lead-in's animation in array
    # order, so it stays a line; the third route's would inherit the
    # second route's picture, so it replays the animation.
    assert by_text(manifest, "Still here.")["type"] == "text"
    assert shown(manifest, "Still here.") is glow
    watch = by_text(manifest, "Watching the glow.")
    assert watch["type"] == "animation"
    assert {k: v for k, v in watch.items() if k not in ("id", "text")} \
        == {k: v for k, v in glow.items() if k not in ("id", "text")}
    assert shown(manifest, "Watching on.") is watch
    assert [r[1] for r in shape(manifest)[0]["routes"]] == [
        "Still here.", "Somewhere else.", "Watching the glow."]
    note = " ".join(ledger["items"][watch["id"]]["notes"])
    assert "repeats the visual on screen at the menu" in note
    check_folder(tmp_path, out, manifest)


def test_a_held_animation_repeats_as_its_last_frame(tmp_path: Path) -> None:
    assets(tmp_path)
    out, manifest, ledger = extract(tmp_path, ATL + (
        'label start:\n    scene bg\n    show once\n    "Once."\n'
        '    menu "Which?":\n'
        '        "Elsewhere":\n'
        '            scene other\n'
        '            "Somewhere else."\n'
        '        "Stay":\n'
        '            "Still the last frame."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    once = by_text(manifest, "Once.")
    assert once["type"] == "animation" and once["holdLastFrame"] is True
    # Ren'Py shows the held last frame there, so the line's item is that
    # frame as a picture, not the animation played again.
    stay = by_text(manifest, "Still the last frame.")
    assert stay["type"] == "image"
    assert stay["file"] == once["frames"][-1]
    check_folder(tmp_path, out, manifest)


def test_a_route_s_first_line_over_the_lead_in_s_video(
        tmp_path: Path) -> None:
    assets(tmp_path, video=True)
    out, manifest, ledger = extract(tmp_path, CLIP + (
        'label start:\n    scene clip with dissolve\n    "It plays."\n'
        '    menu "Which?":\n'
        '        "Elsewhere":\n'
        '            scene other\n'
        '            "Somewhere else."\n'
        '        "Watch":\n'
        '            "Watching the clip."\n'
        '            "Watching on."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    clip = by_text(manifest, "It plays.")
    watch = by_text(manifest, "Watching the clip.")
    assert watch["type"] == "video"
    # The same file and poster, one shipped copy, its sound with it.
    for key in ("file", "poster", "durationSeconds"):
        assert watch[key] == clip[key]
    assert watch["audio"]["videoSound"] == clip["audio"]["videoSound"]
    # A repeat is no new entrance: the lead-in's transition stays its own.
    assert "transition" in clip and "transition" not in watch
    assert shown(manifest, "Watching on.") is watch
    assert kinds(manifest) == [
        ("video", "It plays."), ("image", "Somewhere else."),
        ("video", "Watching the clip."), ("text", "Watching on."),
        ("text", "After.")]
    check_folder(tmp_path, out, manifest)


def test_a_later_route_s_first_line_is_said_over_the_menu_s_picture(
        tmp_path: Path) -> None:
    # Pictures only: the route after one that changed the scene shows the
    # scene on screen at the menu, not that route's.
    assets(tmp_path)
    out, manifest, ledger = extract(tmp_path, (
        'label start:\n    scene bg\n    "Lead."\n'
        '    menu "Which?":\n'
        '        "Elsewhere":\n'
        '            scene other\n'
        '            "Somewhere else."\n'
        '        "Stay":\n'
        '            "Still here."\n'
        '    "After."\n    return\n'))
    assert menu_reports(ledger) == []
    lead = by_text(manifest, "Lead.")
    assert picture(shown(manifest, "Still here.")) == picture(lead)
    assert kinds(manifest) == [
        ("image", "Lead."), ("image", "Somewhere else."),
        ("image", "Still here."), ("text", "After.")]
    check_folder(tmp_path, out, manifest)


def test_a_route_video_the_asset_pass_drops_withdraws_the_decision(
        tmp_path: Path) -> None:
    # A route item that does not ship would leave a route reference
    # dangling: the decision is withdrawn and reported, the rest kept.
    assets(tmp_path)
    (tmp_path / "proj" / "game" / "clip.mp4").write_bytes(b"not a video")
    out, manifest, ledger = extract(tmp_path, CLIP + (
        'label start:\n    scene bg\n    "Lead."\n'
        '    menu "Watch the clip?":\n'
        '        "Yes":\n'
        '            scene clip\n'
        '            "It plays."\n'
        '        "No":\n'
        '            "Not now."\n'
        '    "After."\n    return\n'))
    assert "branches" not in manifest
    assert menu_reports(ledger) == [
        "menu unsupported (route item dropped by the asset pass): decision "
        "withdrawn, linear flow kept"]
    assert kinds(manifest) == [("image", "Lead."), ("image", "Not now."),
                               ("text", "After.")]
    check_folder(tmp_path, out, manifest)
