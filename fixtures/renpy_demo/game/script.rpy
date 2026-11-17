# Synthetic Ren'Py project for the kinetic extractor tests.
# Exercises the statement subset from docs/stack.md; Cyrillic lines included.
# Sound: music by its automatic audio name, an ambience loop on a registered
# channel, a one-shot, a voice line, music and a stop inside a choice block,
# and a movie with an audible soundtrack.

define a = Character("Ana")
define d = Character("Dmitri")
define g = Character("Гостья")

image bg-room "data/bg-room.png"
image bg-yard "data/bg-yard.png"
image mislabel-bmp "data/mislabeled.png"
image mislabel-png "data/mislabeled.jpg"
image bg-reprise "data/bg-room.png"
image photo-noise "data/photo-noise.png"
image bg-gif "data/anim.gif"

init python:
    renpy.music.register_channel("ambience", "sfx", True)

label start:
    $ greeting = "Are you ready"
    play music theme fadein 2.0
    play ambience "audio/rain.webm"
    scene bg-room
    a "Welcome to the house."
    voice "voice/viktor-01.mp3"
    Viktor "The lights are dim. [greeting]?"
    play sound "audio/door.wav"
    d "The fire is low, but the room is warm."
    window show
    with dissolve

    movie "data/clip.mp4"
    a "The screen flickers to life."
    d "Тени танцуют на стене."
    stop movie

    show layer master at 0.5
    scene black
    show bg-yard
    "Тишина в саду. [wind]"
    g "It almost feels like home."
    hide bg-yard

    menu "The evening is yours to spend.":
        "Warm the room again":
            scene bg-room
            a "The fire crackles as the room warms."
            d "Tea, then. The strong kind."
        "Walk the garden path":
            stop ambience fadeout 1.0
            play music "<from 0.5 loop 1.0>audio/theme.mp3"
            show bg-yard
            g "The gravel sounds louder at night."
            "Somewhere past the hedge, water runs."
    with dissolve

    "The night settles over the house."

    menu:
        "Go back inside":
            jump inside
        "Stay under the stars":
            d "The sky is impossibly wide."

    imgfl 12345
    call distant_scene
    jump inside

label inside:
    scene bg-room
    if persistent.seen_ending:
        d "Good night."
    a "Back inside, where it is quiet."
    d "Good night."
    scene mislabel-bmp
    a "A small painting on the wall."
    show mislabel-png
    "The frame beside it hides its true format too."
    show bg-reprise
    d "The same room again, seen from the hall."
    scene photo-noise
    a "A photograph, grainy and warm."
    show bg-gif
    "A tiny paper lantern blinks by the door."
    movie "data/talk.mp4"
    d "The television hums along."
    extend " Then it falls silent."
    stop movie
    return

# Translations: game/tl/ holds German (de), Simplified Chinese (zhCN) and an
# unknown language name (klingon). The line inside the `if` of label inside
# repeats a later line of the same label, so Ren'Py suffixes the later one's
# translation identifier with _1. The `extend` line after the television's
# line continues it in one box: one item, whose translation joins both
# lines' translations.
