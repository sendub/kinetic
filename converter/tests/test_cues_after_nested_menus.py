"""A cue after a nested menu plays on every route (docs/plan.md Phase 60
item 9o2i).

A sound or music cue between a nested menu's close and the end of the
enclosing route, no line between, is passed by every route of the nested
decision that goes on, as Ren'Py's flow does. It was laid out after the
nested `menu-close`, so it waited for the next item and went, at the
enclosing route's end, on that route's last item: the nested decision's
last route's. A reader who chose another nested route never heard it. It
now goes on the last item of each nested route that goes on (a route
that ends the story or jumps back to its menu never passes it), each
with the ambience that route left. Before, such a cue (or a bare `with`
or `pause`) written in place, not through a called label's `return`,
also was the nested menu's join: the join's path met no item before the
enclosing route's end, so the nested routes were `"ending"`. The join
now passes those statements to where the enclosing menu's choices meet,
as it passes a block's end.

Each case is a synthetic project extracted end to end and checked as
test_jump_menus checks its folders: `kinetic validate --strict` prints
nothing and `kinetic check --steps all` walks to the story's end.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from test_jump_menus import LEAD, check_folder, extract, ogg, shape, texts

NESTED = [("Rest", "You rest.", "You rest.", "continue"),
          ("Wait", "You wait.", "You wait.", "continue")]


def sounds(tmp_path: Path, *names: str) -> None:
    audio = tmp_path / "proj" / "game" / "audio"
    audio.mkdir(parents=True, exist_ok=True)
    for k, name in enumerate(names):
        ogg(audio / f"{name}.ogg", 330 + 110 * k)


def in_place(cue: str) -> str:
    """An enclosing menu whose first route says a line and ends with a
    nested menu followed by ``cue``; a line after the enclosing join."""
    return (LEAD + '    menu:\n'
            '        "Visit":\n            "You visit."\n'
            '            menu:\n'
            '                "Rest":\n                    "You rest."\n'
            '                "Wait":\n                    "You wait."\n'
            f'            {cue}\n'
            '        "Stay":\n            "You stay."\n'
            '    "After."\n    return\n')


def audio_of(manifest: dict) -> dict[str | None, dict]:
    """Each item's audio by its text."""
    return {i.get("text"): i["audio"] for i in manifest["items"]
            if "audio" in i}


def enclosing(nested_end: str = "You wait.") -> dict:
    return {"after": "Lead.",
            "routes": [("Visit", "You visit.", nested_end, "continue"),
                       ("Stay", "You stay.", "You stay.", "continue")],
            "continuing": "Stay", "continueAt": "After."}


DOOR = {"sfx": [{"track": "door", "channel": "sound"}]}


def test_a_sound_after_a_nested_menu_plays_on_every_route(tmp_path: Path
                                                          ) -> None:
    """The sound reached only the nested decision's last route, whose
    routes were `"ending"` because the sound was their join: both nested
    routes go on to the enclosing join and each ends with the sound, the
    enclosing route's other choice and the join without it."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(
        tmp_path, in_place('play sound "audio/door.ogg"'))
    assert texts(manifest) == ["Lead.", "You visit.", "You rest.",
                               "You wait.", "You stay.", "After."]
    assert shape(manifest) == [
        {"after": "You visit.", "routes": NESTED, "continuing": "Wait",
         "continueAt": "After."},
        enclosing()]
    assert audio_of(manifest) == {"You rest.": DOOR, "You wait.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_music_after_a_nested_menu_starts_on_every_route(tmp_path: Path
                                                        ) -> None:
    """A music change is the state each nested route goes on with, so
    the join plays it after either nested route, and not after the
    enclosing route's other choice."""
    sounds(tmp_path, "theme")
    out, manifest, _ledger = extract(
        tmp_path, in_place('play music "audio/theme.ogg"'))
    assert shape(manifest)[0]["routes"] == NESTED
    assert audio_of(manifest) == {"You rest.": {"music": "theme"},
                                  "You wait.": {"music": "theme"}}
    check_folder(tmp_path, out, manifest)


def test_stopping_music_after_a_nested_menu(tmp_path: Path) -> None:
    """Music started before the enclosing menu stops after either nested
    route."""
    sounds(tmp_path, "theme")
    out, manifest, _ledger = extract(tmp_path, in_place('stop music').replace(
        '    "Lead."\n', '    play music "audio/theme.ogg"\n    "Lead."\n'))
    assert shape(manifest)[0]["routes"] == NESTED
    assert audio_of(manifest) == {"Lead.": {"music": "theme"},
                                  "You rest.": {"music": None},
                                  "You wait.": {"music": None}}
    check_folder(tmp_path, out, manifest)


@pytest.mark.parametrize("cue", ["with dissolve", "pause 1.0"])
def test_a_bare_with_or_pause_after_a_nested_menu(tmp_path: Path,
                                                  cue: str) -> None:
    """A statement that shows nothing new between the nested menu and the
    enclosing route's end no longer makes the nested routes endings."""
    out, manifest, _ledger = extract(tmp_path, in_place(cue))
    assert shape(manifest) == [
        {"after": "You visit.", "routes": NESTED, "continuing": "Wait",
         "continueAt": "After."},
        enclosing()]
    check_folder(tmp_path, out, manifest)


def test_a_sound_after_a_called_nested_menu(tmp_path: Path) -> None:
    """Item 9o2f's shape: the choice calls a label whose menu is followed
    by the sound and `return`. Its routes already went on in the caller;
    the sound now ends each of them."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Visit":\n            call talk\n'
        '        "Stay":\n            "You stay."\n'
        '    "After."\n    return\n'
        'label talk:\n'
        '    menu:\n'
        '        "Rest":\n            "You rest."\n'
        '        "Wait":\n            "You wait."\n'
        '    play sound "audio/door.ogg"\n'
        '    return\n'))
    assert shape(manifest) == [
        {"after": "Visit", "routes": NESTED, "continuing": "Wait",
         "continueAt": "After."},
        {**enclosing(), "routes": [
            ("Visit", "Visit", "You wait.", "continue"),
            ("Stay", "You stay.", "You stay.", "continue")]}]
    assert audio_of(manifest) == {"You rest.": DOOR, "You wait.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_a_sound_after_a_nested_menu_in_an_if_arm(tmp_path: Path) -> None:
    """The enclosing decision is an `if` chain the walk converts."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, (
        'default hour = "day"\n'
        'init python:\n'
        '    def tick():\n'
        '        global hour\n'
        '        hour = "night"\n'
        + LEAD + '    $ tick()\n'
        '    if hour == "day":\n'
        '        "Day."\n'
        '        menu:\n'
        '            "Rest":\n                "You rest."\n'
        '            "Wait":\n                "You wait."\n'
        '        play sound "audio/door.ogg"\n'
        '    else:\n'
        '        "Evening."\n'
        '    "After."\n    return\n'))
    decisions = shape(manifest)
    assert decisions[0] == {"after": "Day.", "routes": NESTED,
                            "continuing": "Wait", "continueAt": "After."}
    assert decisions[1]["continueAt"] == "After."
    assert audio_of(manifest) == {"You rest.": DOOR, "You wait.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_a_nested_route_that_ends_the_story_never_passes_it(
        tmp_path: Path) -> None:
    """A nested choice that ends the story does not reach the sound."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, in_place(
        'play sound "audio/door.ogg"').replace(
        '                "Wait":\n',
        '                "Leave":\n                    "You leave."\n'
        '                    return\n'
        '                "Wait":\n'))
    assert shape(manifest)[0]["routes"] == [
        NESTED[0], ("Leave", "You leave.", "You leave.", "ending"),
        NESTED[1]]
    assert audio_of(manifest) == {"You rest.": DOOR, "You wait.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_menus_nested_twice_pass_the_sound_on_every_route(tmp_path: Path
                                                          ) -> None:
    """A menu nested in a nested route, its routes going on where the
    enclosing ones do: the sound after the middle menu ends each of the
    innermost routes and the middle menu's other route."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, in_place(
        'play sound "audio/door.ogg"').replace(
        '                    "You rest."\n',
        '                    "You rest."\n'
        '                    menu:\n'
        '                        "Sit":\n'
        '                            "You sit."\n'
        '                        "Lie":\n'
        '                            "You lie."\n'))
    assert texts(manifest) == ["Lead.", "You visit.", "You rest.",
                               "You sit.", "You lie.", "You wait.",
                               "You stay.", "After."]
    assert all(r[-1] == "continue" for d in shape(manifest)
               for r in d["routes"])
    assert audio_of(manifest) == {"You sit.": DOOR, "You lie.": DOOR,
                                  "You wait.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_each_nested_route_keeps_its_own_ambience(tmp_path: Path) -> None:
    """A loop one nested route started stops after the menu on that
    route; the other route, playing no loop, gets no ambience change."""
    sounds(tmp_path, "rain")
    out, manifest, _ledger = extract(tmp_path, in_place('stop sound').replace(
        '                    "You rest."\n',
        '                    play sound "audio/rain.ogg" loop\n'
        '                    "You rest."\n'
        '                    "You sit."\n'))
    assert audio_of(manifest) == {"You rest.": {"ambience": ["rain"]},
                                  "You sit.": {"ambience": []}}
    check_folder(tmp_path, out, manifest)


def test_a_sound_inside_one_route_stays_on_that_route(tmp_path: Path
                                                      ) -> None:
    """Guard: a sound after a nested route's last line, inside that
    route, plays on that route only."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, in_place('"Back."').replace(
        '                    "You rest."\n',
        '                    "You rest."\n'
        '                    play sound "audio/door.ogg"\n'))
    assert audio_of(manifest) == {"You rest.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_a_sound_before_a_line_in_the_route_goes_on_it(tmp_path: Path
                                                       ) -> None:
    """Guard: a line after the sound, in the enclosing route, is where
    the nested routes go on, and it takes the sound."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, in_place(
        'play sound "audio/door.ogg"\n            "Back."'))
    assert shape(manifest)[0] == {"after": "You visit.", "routes": NESTED,
                                  "continuing": "Wait", "continueAt": "Back."}
    assert audio_of(manifest) == {"Back.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_a_sound_after_a_top_level_menu_stays_on_the_join(tmp_path: Path
                                                          ) -> None:
    """Guard: after a menu that is not nested, the sound waits for the
    join's first item, which every route reaches."""
    sounds(tmp_path, "door")
    out, manifest, _ledger = extract(tmp_path, (
        LEAD + '    menu:\n'
        '        "Rest":\n            "You rest."\n'
        '        "Wait":\n            "You wait."\n'
        '    play sound "audio/door.ogg"\n'
        '    "After."\n    return\n'))
    assert shape(manifest)[0]["continueAt"] == "After."
    assert audio_of(manifest) == {"After.": DOOR}
    check_folder(tmp_path, out, manifest)


def test_an_enclosing_join_that_shows_nothing_is_not_passed(
        tmp_path: Path) -> None:
    """Guard: the nested menu ends its route with nothing after it, and
    the enclosing menu's choices meet at a bare `with`: the nested routes
    go on where the enclosing ones do, at the line past it, as before;
    the join is not passed by."""
    out, manifest, _ledger = extract(tmp_path, in_place('"Back."').replace(
        '            "Back."\n', '').replace(
        '    "After."\n', '    with fade\n    "After."\n'))
    assert shape(manifest) == [
        {"after": "You visit.", "routes": NESTED, "continuing": "Wait",
         "continueAt": "After."},
        enclosing()]
    check_folder(tmp_path, out, manifest)
