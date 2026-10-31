# Synthetic Ren'Py project for the kinetic extractor tests.
# Exercises the statement subset from docs/stack.md; Cyrillic lines included.

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

label start:
    $ greeting = "Are you ready"
    scene bg-room
    a "Welcome to the house."
    Viktor "The lights are dim. [greeting]?"
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
    return
