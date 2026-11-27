# Future features

Features not yet scheduled. None of them is in docs/progress.md. An entry
marked "requested" is one the user asked for. An entry marked "maybe" is a
candidate the user has not asked for yet but wants kept on record. When
the user schedules one, it becomes a phase in docs/plan.md with its
checklist items, and its entry here goes. A large entry may become several
phases, and the user may take only some of its candidates. Each entry's
"To settle" list holds the decisions to put to the user before the phase
is planned.

## Authoring from scratch (maybe, 2026-11-14)

Today a hand-author writes the runtime format directly (CREATE.md,
"Hand-authoring a content folder"):

- `manifest.json` by hand: unique ids, each branch as `after`, `start`,
  `end` and `continueAt` spans over one flat item list, segment times,
  and audio tracks with decoded `durationSeconds`;
- every image, animation frame and poster cropped to the exact display
  size with ffmpeg, video durations read with ffprobe;
- looping sound re-encoded to a loop-safe format, and each sound file's
  `<file>.js` script written with `base64` and `printf`;
- `manifest.js` written with `printf`, then the validator run.

`kinetic-media ship` already does the media half for converters:
display-size images, posters, durations measured by decoding, loop-safe
audio, the audio scripts, and cached reproducible encodes (CREATE.md,
"Writing your own converter: kinetic media ship").

Candidates, in a workable order:

1. **A build over a source folder.** The author's manifest names original
   files at any size. The build ships them through kinetic-media, fills in
   posters, durations and audio scripts, writes `manifest.js`, validates
   and assembles. No ffmpeg by hand, and no new format.
2. **A script format compiled to the manifest.** Lines read as
   `Speaker: text`, a media line sets the visual, and indentation under a
   choice holds each route, so the author writes no spans. It needs syntax
   for video ranges, segments, sound and route results. Errors name the
   script line, not a JSON path. A sketch:

   ```text
   # Rainy Day
   story: rainy-day
   size: 1280x720

   [image] art/kitchen.png
   Mei: You're early today.
   Mei (thinks): The street glowed under the awning.
   Neither of us spoke for a while.

   ? How does the afternoon go?
     > To the cafe [ending]
       [image] art/cafe.png
       We took the corner table.
     > Straight home [continue]
       [image] art/street.png
       We walked home under one umbrella.
   ```

3. **Stable ids.** Progress, seen marks and bookmarks are stored by item
   id, so a compiled id must not change when the author inserts a line
   above it. Either the compiler keeps a lock file mapping lines to ids,
   or ids come from a section name plus a hash of the line, with an
   explicit `{#id}` to pin one.
4. **A live preview.** Rebuild on save, reload the page, and open at the
   item being edited through the existing `#start=<id>` (CREATE.md,
   "Playing the folder").
5. **Placeholder art.** A missing image becomes a generated card at
   display size naming the file, so the story plays end to end before the
   art exists. The build lists the placeholders left, and a release build
   refuses them.
6. **A starter.** `kinetic new <folder>` writes a small working project.

To settle:

- Kinetic's own syntax, or an existing one (Ink, a Ren'Py subset, a
  Markdown-like form).
- Whether the script becomes the only source, or a hand-edited manifest
  stays supported beside it.
- The id scheme.
- Where the compiler lives: the converter package or a new one.

## Author checks and helpers (maybe, 2026-11-14)

Phase 57 gives agents `kinetic report`, `kinetic routes` and `kinetic
export`, which print text. The parts below serve a person looking at a
screen, so they stayed here.

Candidates:

- **The route graph** as a page or SVG for the author, from the branch
  map's model (`player/src/render/mapmodel.ts`).
- **A video range picker.** A local page plays a clip and marks
  `startSeconds`, `endSeconds`, `loopStartSeconds` and segment times to
  the frame, then prints the manifest fields or script lines. Typing
  fractional seconds is the slowest part of writing a video item.
- **Placeholders left** in `kinetic report`, once "Authoring from
  scratch" has them.

To settle:

- Which of these.

## Click and touch input (maybe, 2026-11-14)

Today the story advances only from keys and the mouse wheel. Clicks act
on the Esc screen, choice rows, the branch map and the Volumes pop-out. A
click on the story enters fullscreen and starts sound, and nothing else.
Mouse readers expect a click to advance, and a touchscreen laptop or
tablet has no Space, Esc, `m` or `b`.

Candidates:

- A click or tap advances, as Space does.
- An on-screen button opens the Esc screen, with buttons for the map, a
  bookmark, hiding the text and auto-forward.
- A swipe steps back and forward, as the wheel does.

Designing for web hosts is not wanted (below), so phones and tablets may have no way
to open a game folder at all: iOS and Android browsers do not open a
local `index.html` with its scripts (not verified). The gain is then mouse
readers and touchscreen Windows and Mac laptops.

To settle:

- What a click does in auto-forward, in skip and on a choice screen.
- Which part of the screen takes the click.
- Whether on-screen buttons show on a device with no touchscreen.
- Whether touch is in scope at all.

## Signed apps for downloads (maybe, 2026-11-14)

Today `kinetic apps` signs the Mac app ad hoc, for arm64 only
(macOS 12 or later), and leaves the Windows program unsigned. A folder
the author builds opens with no prompt. From a downloaded zip the Mac
app is refused and the Windows program meets SmartScreen (docs/stack.md,
"Distribution decision"), so readers of a download use `index.html`.

Candidates:

- Developer ID signing and notarization with the author's own Apple
  identity, as options on `kinetic apps`.
- Authenticode signing of the Windows program with the author's
  certificate, after `kinetic apps` writes the game's resources (it
  refuses to rewrite a signed exe, as that breaks the signature).
- **One signed player for every game** (the user, 2026-11-17). A
  signature covers the exact bytes of the app, and `kinetic apps`
  writes each game's title, storyId and icon into its copy of the host,
  so a signature on the prebuilt host cannot carry over to a game's
  app: each author would sign their own, or send it to someone else to
  sign as its publisher. Instead, a generic Kinetic player app and exe,
  signed and notarized once per Kinetic release with the Kinetic
  developer's Apple Developer ID and a Windows code-signing
  certificate, ship unchanged beside any game folder and read the
  game's title and storyId from the folder at launch (a game's HTML,
  JavaScript and media are data, not code, so Gatekeeper and SmartScreen
  check only the signed player). Every Kinetic game downloaded with it
  opens with no refusal or warning, and the one exe builds SmartScreen
  reputation across everyone's downloads. The cost is per-game identity:
  Finder, the menu bar and the exe's file properties say "Kinetic" and
  show Kinetic's icon (the window title and Dock icon can still be the
  game's, set at launch), and all games share one app identity, so
  macOS's per-app language setting applies to every Kinetic game (saves
  are per storyId already). Per-game apps signed by their own authors
  can stay beside it for authors who want their game's name and icon.
  The phase-closer would sign, notarize and attach the player to each
  release.

To settle:

- Whether readers should run the apps from a download at all.
- One signed player, per-game apps signed by their authors, or both.
- How the author's identity reaches the build (a keychain profile name,
  never a secret in the repo).
- Testing: agents cannot notarize without the user's Apple account, so
  the user runs that check.

## Accessibility (maybe, 2026-11-14)

Today the player follows `prefers-reduced-motion` for its button
transitions only. It has no text size setting, no opaque text box, no
screen-reader announcement of lines (no `aria-live` region), and Phase
47's sound has no captions. Spoken lines are docs/plan.md Phase 52.

Candidates:

- A text size setting.
- An opaque or darker text box for busy art.
- A reduced-motion setting that holds animations on their first frame
  and videos on their poster.
- Each line announced to screen readers.
- Captions for sound effects, such as a `caption` on a track.

To settle:

- Which of these.
- Where the settings sit; Phase 47 rebalanced the Esc screen for the
  Volumes pop-out.
- Whether reduced motion changes the timing rules in
  docs/content-format.md, "Timing".

## Title screen and About screen from the game's menus (requested, 2026-11-26)

The user asked whether a Ren'Py game's main-menu picture or video could
open the converted story, and whether the menu's links to the author's
sites, with an About text and a changelog, could go on a screen of
their own. A survey of 53 corpus games whose screens could be read
(2026-11-26, archives and compiled scripts included):

- The title picture: the template's `define gui.main_menu_background`
  (gui.rpy), drawn by `add gui.main_menu_background` in `screen
  main_menu`, is changed from the template's file in 50 and drawn that
  way in 36; 26 add other images in `main_menu` (a logo over a
  background, layered pictures, an imagemap), 11 use a `Movie(...)`
  displayable there or in gui.rpy.
- Links: 33 have `OpenURL("...")` buttons in `main_menu` or
  `navigation` (author pages, support pages, community servers).
- About: 44 set `define gui.about = _p("""...""")` (options.rpy), the
  text Ren'Py's About screen shows, translatable through the `strings`
  block. No Ren'Py standard exists for a changelog.

Candidates:

- The converter puts the main menu's background (`gui.main_menu_background`,
  or the one picture or movie `main_menu` adds) as an image or video
  item before the story's first item, with the game's `title` drawn on
  it or as its line.
- A player "About" screen reached from the Esc screen: the manifest's
  `title` and `version`, an optional `about` text (from `gui.about`,
  translated per language), `links` (label and URL, from the menu's
  `OpenURL` buttons) and an optional `changelog` the author writes.

To settle:

- Whether the title picture is a story item (seen, bookmarked, in the
  wheel) or a title screen of its own shown before the first item, and
  what a layered menu (logo plus background), an imagemap or a movie
  becomes.
- Whether to keep a picture still showing the game's own menu buttons.
- The About screen's place (Esc screen tab, key), how links open in a
  browser and in the Mac and Windows apps (an external browser, a
  confirmation), which URL schemes are allowed, and how the label of a
  link drawn as a picture button is found.
- The changelog's form (Markdown, plain text, per version) and whether
  `kinetic report` and `validate` check the new fields.

## Routes that share a tail (maybe, 2026-11-26)

Ren'Py games often send many choices, across nested menus, to one label
(a common failure scene) that then rejoins the story. Kinetic routes
cannot share items, so Phase 60's converter keeps such a menu linear
("rejoins content read at ..."): on a converted corpus game, 23 of 61
menus. Candidates:

- A route that ends by joining another place than its decision's
  `continueAt` (a per-route join), with the shared content laid out
  once as a route of its own.
- The converter copying the shared scene into each route that reaches
  it, at the cost of repeated items.

To settle:

- Whether the format grows a per-route join, and how the wheel, `u`,
  the end card and play-all treat it.
- Whether copies are acceptable, and how seen marks count them.

## Per-language pictures (maybe, 2026-11-16)

Phase 56 keeps pictures the same in every language. Words drawn into a
picture (a phone screen, a sign, a title card) stay in the original
language; an author can put them in a text item instead. Ren'Py can
replace a file per language (`game/tl/<language>/`), but no game in the
corpus does.

Candidates:

- A language file swapping an `image` item's file, or an animation's
  frames, for its own.
- Video swaps, much heavier and rarer.

To settle:

- Whether a real game needs it.
- How `kinetic-media ship`, the media ledger, `rebuild`, poster checks
  and preloading handle files per language.

## Ren'Py auto-voice files (maybe, 2026-11-17)

Ren'Py's `config.auto_voice` plays `voice/<identifier>.ogg` for a line,
named by the line's translation identifier. Phase 56's converter now
computes those identifiers (on a converted corpus game 3,978 of its
lines matched such files), so kinetic-extract could ship them as the
items' recorded voice lines.

To settle:

- Whether to ship them by default, and how the author confirms the
  pattern.
- Per-language voice folders, if a game has them.

## Free-roam stories (requested, 2026-11-27)

The largest loss in the corpus survey of 2026-11-27 (71 projects
walked with the 1.15.0-dev converter): about 409,000 story lines in
40 games are reached only through free-roam navigation, which the
converter's walk does not follow. The forms:

- Labels reached only from screen actions: a map or room screen whose
  buttons `Jump`, `Call`, `Function` or `SetVariable` then `Return`
  (about 84,000 lines), and `Jump` actions on screens never shown in
  label flow (about 61,000).
- Label names built at run time (`jump expression "day" + str(d)`,
  about 113,000), loops with no literal entry (about 116,000), and
  Python location or event objects choosing the next scene (about
  28,000).
- Gallery `Replay` actions (about 7,000).

Such a story is a hub of scenes the reader visits in any order, often
again, with scenes unlocked by time of day or progress. Kinetic plays
one fixed order with branches.

To settle:

- Whether the converter lays the scenes out in one sensible order (by
  day, by unlock order) as a linear story with each hub visit a
  decision, or the format grows a hub: a set of scenes read in any
  order, each once, with the map showing them.
- How far the converter follows screen actions and computed label
  names (the candidates a `jump expression` can reach, the buttons of
  a screen the story calls).
- What the reader sees for scenes the game gates by state Kinetic does
  not track (time of day, money, stats).

## Dialogue from creator-defined statements (maybe, 2026-11-27)

Some games define their own statements (`renpy.register_statement`)
for phone chats or texting screens, `chat who "Hello"`, whose
arguments are story lines; the converter reports them as
unrecognized (about 1,000 lines in 2 corpus games). Each game defines
its own grammar, so a general rule cannot read them.

To settle:

- A per-game hook, like the media decoder hooks: a function the
  converting agent writes that turns such a statement into items.
- Or a chat item in the format (a phone screen with message bubbles),
  which the hook would produce.

## Cosmetic gaps from the corpus survey (maybe, 2026-11-27)

Found by the 2026-11-27 survey; none loses a line:

- `show x at left` sprites replace the picture instead of layering on
  the background (3,028 shows in 30 games): Kinetic shows one picture
  per item. Layering needs the player to compose a scene from layers,
  or the converter to composite them.
- Custom text tags (10,375 lines in 13 games) show as text or are
  stripped.
- `renpy.movie_cutscene` calls (304 in 19 games) play nothing.
- `nvl` mode, `show text`, and transitions that become cuts.
- Speakers that are Character objects built by the game's own Python
  classes (`self.c = Character(name)`, a `.t` property; 4,757 lines in
  3 games after Phase 60 item 9m) keep the dotted name as the speaker:
  reading them needs the converter to run the game's Python.
- `show screen x` over a scene draws nothing (item 9n3): one corpus
  game shows about 13,500 lines over black for it. Showing a screen
  needs its displayables read and composed.
- `layeredimage` definitions are not read (item 9n): showing one needs
  its layers composed into one picture, as for `show x at left` above.
- Double spaces inside one line of a say string stay, where Ren'Py
  collapses them; changing it would alter existing texts and
  translation matching.
- ATL `alpha` beyond a shown solid colour's own block (item 9n5): an
  `image x:` block of a solid colour with `alpha` (stays an image with
  no file), a one-frame ATL image's `alpha`, `alpha` on a picture
  (`show black: alpha 0.5` where `black` is a file), and `alpha` from a
  named transform (`show black at half`); a few dozen lines in two
  corpus games. A frame list with one translucent frame shown over a
  picture loses the whole animation.

## Not wanted

- Supporting web hosts, such as itch.io (the user, 2026-11-14,
  clarified 2026-11-17): no work to fit a game within a hosting
  platform's limits or rules, and no changes made for one. A game stays
  a folder opened from disk or through its app. A folder is static
  files, so serving it from a web host happens to work, and that is
  welcome (Kinetic's own demo is on GitHub Pages, Phase 57 item 11d);
  it is just not a target to design for.
- Fonts shipped with a game, for its base language or a translation
  (the user, 2026-11-16: game developers choose badly; a good, readable
  system font is wanted). The player picks system fonts by writing
  system.
- Intel Macs (the user, 2026-11-17): the Mac app stays arm64 only, and
  the media tools have no `macos-x86_64` pin.
