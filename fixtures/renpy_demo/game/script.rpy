# Synthetic Ren'Py project for the kinetic extractor tests.
# Exercises the statement subset from docs/stack.md; Cyrillic lines included.

define a = Character("Ana")
define d = Character("Dmitri")
define g = Character("Гостья")

image bg-room "data/bg-room.png"
image bg-yard "data/bg-yard.png"

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
    return
