# Making a New Kinetic Game

Kinetic plays a kinetic visual novel from a content folder: a manifest
listing images, animation frame sets, videos, and `text` dialogue lines
in play order, plus the media files the manifest references. Two paths
produce such a folder: converting a Ren'Py project with `kinetic
extract`, or hand-authoring it from content you already have (images,
an animation frame set, a video, and the text you want overlaid). Both
produce the same format, and you validate, check and play the result
the same way either path took.

docs/content-format.md specifies the folder and docs/content-schema.json
defines the manifest; this guide adds the commands.

## Installing Kinetic

Kinetic's tools are one command, `kinetic`, with a subcommand for each
job:

| Subcommand | What it does |
| --- | --- |
| `kinetic setup` | installs the pinned ffmpeg and ffprobe and runs the media self-test |
| `kinetic extract` | converts a Ren'Py project into a game folder |
| `kinetic media` | ships, rebuilds or checks posters of media, with no story parse |
| `kinetic validate` | checks a folder against the content format |
| `kinetic report` | prints reading time, speakers, unused files, long lines and text tag problems |
| `kinetic routes` | prints the branch structure as an outline |
| `kinetic export` | prints the story as Markdown, to lay beside the script |
| `kinetic assemble` | makes the folder readers get: the player beside the content |
| `kinetic apps` | adds the Mac app and the Windows program to a folder |
| `kinetic check` | plays a folder with no window and reports what it showed |
| `kinetic upgrade` | gives a folder this Kinetic's player |
| `kinetic release-status` | prints this Kinetic's version, the commit it was built from, its checklist's counts and its CHANGELOG entry |

`kinetic --help` lists them, `kinetic <subcommand> --help` gives each
one's options, and `kinetic --version` prints the version, as `Kinetic
1.14.0`.

### From a release

What you need:

- Python 3.12 or later.
- For `kinetic check` and your own test scripts only: Node.js 22.12 or
  later, and Google Chrome for the `chrome` engine. On a Mac its default engine is the Mac's own
  WebKit, which needs nothing more.
- For the Mac app (`kinetic apps --mac`): macOS, whose own `codesign`
  signs it.

Nothing else: no Swift, Go, npm or clone of the repo. Each release on
GitHub, https://github.com/sendub/kinetic/releases, carries a wheel,
`kinetic-X.Y.Z-py3-none-any.whl` for release X.Y.Z. Install it into a
venv of its own, then run setup once:

```sh
python3 -m venv ~/kinetic-venv
~/kinetic-venv/bin/pip install https://github.com/sendub/kinetic/releases/download/vX.Y.Z/kinetic-X.Y.Z-py3-none-any.whl
~/kinetic-venv/bin/kinetic setup
```

Put `~/kinetic-venv/bin` on your PATH, so that `kinetic` runs as this
guide writes it.

`kinetic setup` downloads the pinned static ffmpeg and ffprobe for your
system, checks their sha256 against the pins, and runs a self-test:
every media tool path runs on samples the wheel carries, and each
output's sha256 must equal the pinned "golden" value, so a folder
converted on your machine is byte for byte the one any other machine
makes. A good run ends:

```text
setup_media_tools: self-test passed (22 cases)
setup_media_tools: media tools ready in .../Kinetic/media-tools/macos-arm64
```

The converter uses only these tools, never the ffmpeg on your PATH,
and `kinetic extract` and `kinetic media` refuse to run until this
self-test has passed. The tools are pinned for Apple silicon Macs
(`macos-arm64`), 64-bit Windows on Intel or AMD (`windows-x86_64`) and
64-bit Linux on Intel or AMD (`linux-x86_64`), so you can convert on
any of those. Linux on Arm (`linux-arm64`) is not pinned yet: there
setup stops and says so, and every subcommand but `setup`, `extract`
and `media` still runs. Intel Macs are not supported.

A few media recipes give other bytes on an Intel or AMD processor than
on Apple silicon (some audio encodes, video posters and H.264
transcodes), so a folder's media are reproducible on the platform that
made it. Its ledger records that platform, and `kinetic media rebuild`
verifies the folder there; on another platform it stops with `made on
<platform>; rebuild there to verify` (exit 3; Checking a folder with
rebuild).

An installed Kinetic keeps the media tools and its caches in folders of
your own: `~/Library/Application Support/Kinetic` and
`~/Library/Caches/Kinetic` on macOS, `%LOCALAPPDATA%\Kinetic` on
Windows, `~/.local/share/kinetic` and `~/.cache/kinetic` on Linux.
`KINETIC_HOME=DIR` puts both under DIR. docs/packaging.md, "Installing
the tools", has the details and says how the wheel is built.

A newer release installs the same way, over the old one; run `kinetic
setup` again after it, since the pins may have changed (Upgrading to a
newer Kinetic).

The wheel leaves out the tools for voices and translations
(`tools/cast_voices.py`, `tools/record_lines.py` and
`tools/translations.py`): those need a checkout. It carries the testing
library for your own test scripts; `kinetic check --library` prints the
path to import (A test script).

### In a checkout

To work on Kinetic itself, or to use the tools the wheel leaves out,
clone the repo and set it up once:

```sh
git clone https://github.com/sendub/kinetic.git
cd kinetic
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt --cache .tmp/pip-cache
.venv/bin/pip install -e ./converter --cache .tmp/pip-cache
.venv/bin/kinetic setup
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
```

The pip lines install the pinned Pillow, imagecodecs (libjxl) and
numpy, and the converter with its commands. `.venv/bin/kinetic`, run
from the repo root, is the same command this guide calls `kinetic`. In
a checkout the media tools go into `.media-tools/<platform>/` and the
caches into `.tmp/`; `kinetic check` runs the checkout's check-game,
which needs the `npm ci` above; `kinetic assemble` and `kinetic
upgrade` copy the player from `player/dist/`, so run `npm run build` in
`player/` after each pull; and making the apps builds their host
programs once, which needs Swift and Go (Building the apps). Run the
pip lines and `kinetic setup` again after a `git pull` that changes
`requirements.txt` or `converter/media-tools.json`. A venv that holds
a Kinetic from before 1.12.0, installed under its old name, needs
`.venv/bin/pip uninstall kinetic-extract` before the editable install.

The command names from before `kinetic` still work, with the same
arguments: `kinetic-extract` (`kinetic extract`) and `kinetic-media`
(`kinetic media`), and in a checkout `tools/setup_media_tools.py`,
`validate_content.py`, `assemble_folder.py`, `build_apps.py` and
`upgrade_folder.py`, so notes and scripts written for them stay true.

### Pinning the media tools

Two flags of `kinetic setup` change the pins in
`converter/media-tools.json`, in a checkout; commit the file after
either:

- `--pin`: the first setup on a platform whose archive checksums are
  still null (the pin file lists `macos-arm64`, `linux-x86_64`,
  `linux-arm64` and `windows-x86_64`; all but `linux-arm64` are pinned).
  It records the archives' sha256s once they match the
  publisher's checksums. The golden values are shared by every
  platform and must still match, with one exception: a few recipes
  give other bytes on x86_64 than on arm64 (the cases listed in
  `selftest.cpuDependent`, which only the user extends), and for those
  this first `--pin` records the platform's own goldens. Any other
  difference refuses and writes nothing, so `--pin` cannot hide a
  platform whose tools give different bytes. On Windows run it as
  `.venv\Scripts\python tools\setup_media_tools.py --pin`, the form
  setup's own messages give there.
- `--repin CASE`: only after a deliberate change to a media recipe in
  the converter changes one self-test case's output. It re-records that
  case (repeatable) and prints old and new values; every other case
  must still match. On a platform with its own golden for that case, it
  re-records the platform's one.

Reference: converter/README.md, "Pinned media tools".

## Converting a Ren'Py project

`kinetic extract` turns a Ren'Py project (a folder holding `game/`, the
`game/` folder itself, or a macOS `.app`) into exactly the folder
format of Hand-authoring a content folder, below. It reads `.rpy`
scripts, decompiles `.rpyc` (vendored unrpyc) and reads `.rpa`
archives, follows the story from `label start` as Ren'Py runs it,
turns menus (those whose choices jump included) and `if` chains on a
variable into branches where its walk proves where their paths meet,
keeps speaker colours, crossfades, text tags and frame-by-frame ATL
animations (What the converter carries, below), and does the media work
you would otherwise do by hand: it sniffs true formats, keeps
browser-compatible originals byte-identical or ships them as lossless
JPEG XL when that is smaller, keeps video Safari and Chrome both play,
remuxes H.264/HEVC/VP9 from a container one of them refuses (MKV, AVI,
MPEG-TS) into MP4 without re-encoding, transcodes only other codecs, and makes lossless
posters (PNG, or JPEG XL when smaller). It also ships the sound the
scripts play (music, ambience loops, one-shots and voice lines) and
each video's audible soundtrack. Every media file it ships, posters
included, is named by the sha256 of its bytes, `media/<h[:2]>/<h>.<ext>`
(docs/extracting.md, "Output layout").

The conversion is reproducible: the same game gives the same bytes and
paths on any machine whose pinned tools pass the self-test, and the
folder's build ledger records how to make every media file again from
the original game files, so anyone holding the game can check a folder
with `kinetic media rebuild`.

The steps below use one example game throughout: Rainy Day, released
in two episodes at `~/games/RainyDay/Ep1` and `~/games/RainyDay/Ep2`,
converted into `~/games/RainyDay-Kinetic`. Replace those with your
paths. The commands assume `kinetic` is on your PATH (From a release,
above); in a checkout, run `.venv/bin/kinetic` from the repo root.

### Converting, checking and playing one game

Convert, then check the folder in this order, then assemble and play
it:

```sh
kinetic extract ~/games/RainyDay/Ep1 ~/games/RainyDay-Kinetic
kinetic validate ~/games/RainyDay-Kinetic
kinetic report ~/games/RainyDay-Kinetic
kinetic routes ~/games/RainyDay-Kinetic
kinetic export ~/games/RainyDay-Kinetic --out ~/games/rainy-export
kinetic assemble ~/games/RainyDay-Kinetic ~/games/RainyDay-Play
kinetic check ~/games/RainyDay-Play --steps all
kinetic media rebuild ~/games/RainyDay/Ep1 ~/games/RainyDay-Kinetic
```

None of the checks needs you to watch the game, so an agent converting
a game can run them all and read what they print.

1. `kinetic extract` prints a summary: item and media counts, the
   display size, the story id and title with where each came from, how
   the walk went, the decisions it made of menus and `if` chains, the
   speaker colours and transitions it kept, and one
   line per statement it skipped and per item note (`jxl 131 <
   original 602`, `shares shipped file ...`). Read the `items skipped`
   count, the `walk:` lines and any `warning:` lines (When something
   fails, below). Here, for fixtures/renpy_demo:

   ```text
   items: 35 (animation 1, image 11, text 21, video 2); media shipped: 16; items skipped: 0
   walk: from label start; labels reached 4, unreached 0; lines unreached 0
   branches: 5 detected, 0 menus skipped
   speaker colours: 0 of 4 speakers
   transitions: kept none; with no picture change 2; cut: none
   conditions: 2 decisions from if chains (follows 1, ranges 1, words 0)
   audio: 5 items carry sound; 6 tracks shipped (3 copy, 1 extract, 2 transcode), 0 dropped
   video soundtracks: 1 audible, 0 silent, 1 absent
   ```

   The extractor asks for every video's own sound: an audible one becomes
   its item's `videoSound`, and a `silent` one (digital silence) or an
   `absent` one (no audio stream) is skipped, which is no error. A track
   that did not ship drops its cues, and each audio statement it could
   not convert (a playlist, `set_volume`, a file named by a variable) is
   listed (docs/extracting.md, "Reading Ren'Py audio" and "Shipping the
   sound").
2. `kinetic validate` prints nothing and exits 0 on a good folder,
   translations and all. It warns about items no reading reaches, text
   tag problems and, for a game with translations, each string a
   language lacks; `--strict` makes those warnings exit 3, for a gate
   that must fail on them (Validating, below).
3. `kinetic report` prints what to compare with the original: reading
   time per route, the speakers with their line counts (a look-alike
   name flagged), the colours and transitions, text tag problems, files
   nothing uses, the longest lines and each language's coverage
   (Checking a conversion: kinetic report, below).
4. `kinetic routes` prints the decisions and routes as an outline, to
   compare with the script's menus: a menu the extractor kept linear
   (the summary's `menus skipped`) shows no decision there.
5. `kinetic export` writes the story as Markdown, `main.md` and a file
   per route, each item with its id. Lay each beside its `.rpy` and read
   them together: a scene missing or out of order, a wrong speaker or a
   line cut short shows there (kinetic export, below).
6. `kinetic assemble` makes the folder readers get, the player beside
   the content (Playing the folder, below). Double-click its
   `index.html` to play.
7. `kinetic check --steps all` plays the assembled folder with no
   window, walking every route; it warns about each line that overflows
   the screen at the game's size, fails on a file that does not load,
   names the items it never showed, and with `--trace FILE` writes a
   record of every screen it showed (Testing your game, below).
8. `kinetic media rebuild` makes every media file again from the
   original game and compares hashes; it ends `rebuild OK` (Checking a
   folder with rebuild, below).

To try a big game on part of its story first, add `--label NAME`,
`--max-items N` or `--files GLOB` (converter/README.md, "Usage").

When you convert again after a change that drops media (a different
game version, other options), use a new or empty folder: the extractor
never deletes files, so media left over from the earlier run stays in
`media/` and `rebuild` reports it as `not in the ledger`.

The extractor names the game and the story: the `title` is the
project's `config.name` (else its folder name, with `_` and `-` read as
spaces), and the `storyId` is derived from `config.save_directory`,
`config.name` or the folder name. The game's `version` is the project's
`config.version` when that is a plain string, such as the `define
config.version = "1.0"` in Ren'Py's `options.rpy` template; anything
else gives no `version`. Set them with `--title "Rainy Day"`,
`--story-id rainy-day` (the id must already be a valid `storyId`) and
`--game-version "1.0"` (`--version` prints Kinetic's own version), or
edit `manifest.json` afterwards and regenerate `manifest.js`
(Generating manifest.js). Keep the `storyId` when you convert an
updated game, so readers' progress follows it.

The extractor also writes `manifest.schema.json`, a copy of the schema,
beside the manifest, and opens the manifest with `"$schema":
"./manifest.schema.json"`, so your editor checks the manifest as you
edit it (Manifest). The assembled folder leaves the copy out.

A project with Ren'Py translations under `game/tl/` gets a language file
per language, `lang/<tag>.json` and `lang/<tag>.js`, listed in the
manifest's `languages` (docs/content-format.md, "Translations"): each
`translate` dialogue block goes to the item made from the same line,
found by Ren'Py's own translation identifier, and the `strings` blocks
give the menus' choices and captions, the speakers' names and the
title. The summary prints, per language, the blocks matched and not
(with examples by `file:line`) and the coverage. Ren'Py's fonts (`translate
... style`), `translate ... python` blocks and per-language replacement
files are left out. A `tl/` folder name the extractor does not know
(`klingon`) is skipped with a warning; give its language tag with
`--language-map klingon=tlh` (repeatable). A game whose script is not
in English names its language with `--base-language TAG` (`ja`), which
becomes the manifest's `language`; its `tl/english` then becomes an
English language file. `--no-translations` converts the base language
alone. Fill in what is missing with the translator
tools (docs/translating.md). Reference: docs/extracting.md,
"Translations".

### What the converter carries

Beyond the lines, pictures and sound, a conversion keeps the order
Ren'Py runs the story in and what Ren'Py draws:

- **The story as Ren'Py runs it.** The walk starts at `label start` and
  follows `jump`, `call` (coming back at its `return`) and the fall
  from the end of a label into the next one in the same file, taking
  each statement once: a scene two paths share is read once, and the
  second path rejoins it there. Scripts in subfolders of `game/` are
  read, as Ren'Py loads them, `tl/` aside. Labels the walk never
  reaches are reported, not emitted: the summary's `walk:` lines count
  them, naming up to 20 with the lines of dialogue they hold, and the
  build ledger's `walk` lists each one. Ren'Py's own entry labels
  (`splashscreen`, `main_menu` and the like) are never walked; the
  summary names those the game has.
- **More than the story, when you ask.** `--also-label NAME`
  (repeatable) walks the story from that label after the story, for a
  label readers see that the walk does not reach, and
  `--include-unreached` appends every label still unreached that holds
  dialogue, in file order. Read the `walk:` lines first: a developer
  script or a minigame left out is usually right.
- **Computed jumps.** `jump expression`, `call expression` and
  `renpy.jump(var)` pick their label as the game runs. The walk takes as
  candidates the labels the game's code names in string literals, gives
  each to the site whose own Python names it (else the nearest site in
  its file), and walks them there; the summary lists each site with its
  candidates. A label that Python builds without naming it is not
  followed, and is reported.
- **Menus.** A menu of two or more plain choices becomes a decision,
  whether its choices' blocks hold the lines in place or set variables
  and `jump` (or `call`, or `return`) elsewhere. Each choice's path up
  to where the paths meet is its route; a route reaching that join
  continues there (the last one is the continuing route), a choice
  jumping back to the menu, or to the question before it, returns to
  the choice, and one reaching the story's end is an ending. A choice
  with no line of its own shows its choice text as its one line, as a
  route that opens with a nested menu does before it. A menu of one
  plain choice shows its choice text as a line and reads on. A menu
  stays linear, reported, when every choice is empty, a choice's path
  rejoins another's content away from the join, or a choice is
  conditional (`"x" if cond:`). Before 1.15.0 only menus whose choices
  held their lines in place converted, and those as pure choices whose
  routes all ended, so a reader with Play all routes off read every
  route before going on.
- **Lines as Ren'Py reads them.** Lines indented with non-breaking
  spaces, in the scripts and in `tl/`, read as Ren'Py reads them, and a
  form feed or other unusual line-break character inside a line no
  longer splits it.
- **Speaker colours.** A Character's literal `color` or `who_color`
  becomes its speaker's `nameColor`, and `what_color` its `textColor`,
  in the manifest's `characters` (Speaker colours, below); a colour
  given by an expression is left out, with a report line.
- **Transitions.** `with dissolve`, `with fade`, `Dissolve(t)`,
  `Fade(out, hold, in)` and names `define`d as those give the picture
  they apply to its `transition` (Transitions, below). `with None` and
  every other transition (wipes, moves, punches) cut, and the summary
  counts them by name, as in `transitions: kept dissolve 40, fade 6;
  with no picture change 9; cut: None x31, hpunch x4`.
- **Text tags.** `{i}`, `{b}` and the rest stay in the text as written,
  and the player reads them (Text tags, below).
- **Frame-by-frame animations.** An `image name:` ATL block listing
  frames (quoted files or image names) with `pause N` between them,
  and perhaps a last `repeat` or `repeat N`, becomes an `animation`
  item that `show name` shows, its lines kept: even pauses set `fps`,
  uneven ones `frameSeconds`; a bare `repeat` loops, `repeat N` plays N
  loops and holds the last frame, no `repeat` plays once and holds. A
  frame's `with` plays as a cut and a `function` is dropped, both
  reported. A block of one frame is that picture, its transform
  properties reported as not applied; a block with other ATL (motion
  such as `linear`, `parallel`, `block`, properties over several
  frames) stays `image without a file`, the report naming the
  statement.
- **Conditions.** An `if`/`elif`/`else` chain whose tests read one
  variable the script sets (`$ x = ...`, `+=`, `-=`, `default`,
  `define`) becomes a decision, its arms' lines, pictures and sound
  kept as routes that go on where the arms meet. A variable only one
  menu's choices set gives a decision that follows that menu: with Play
  all routes off the reader's pick there decides, and its routes read
  `If you chose: Wake Robin`. A `$ x = ""` in label flow before that menu
  (and never again after it) is the starting value, as a `default` is. A counter gives an ordinary decision
  labelled by ranges (`love 3 or more`, `love 1 or 2`, `love under 1`),
  and any other test one labelled by the choices that set the value or
  in words (`met is set`), so the reader picks what fits their story; the
  prompt is `Which fits your story so far?`. The words are in the
  game's base language and each language file's own (English for a
  language the catalogue lacks, which `kinetic report` names). Name the
  variables for readers with `--condition-names FILE`, a JSON object
  such as `{"love": "Love", "met_robin": {"en": "Robin met", "fr": "Robin
  rencontré"}}`; keep the file with the game so the labels come back on
  every conversion. A test on two variables, a function call or Ren'Py's
  or persistent state stays as before, its blocks skipped and reported
  `if chain not converted (why)`.

docs/extracting.md, "The walk follows labels", "Conditions", "ATL frame
lists" and "Colours and transitions", has every rule. A folder
converted before Kinetic 1.12.0 gains colours and transitions, and one
converted before 1.15.0 its jump menus, conditions, one-choice lines and
frame-by-frame animations, only by converting it again (Upgrading to a
newer Kinetic).

### Checking a conversion: kinetic report

`kinetic report` reads a game folder and prints what an agent, or anyone
who cannot watch the game, would want to compare with the original. It
opens no browser and needs no media tools:

```sh
kinetic report novel-play
kinetic report novel-play --json
```

- Reading time with auto-forward at the player's default settings, by
  the hold rule of docs/content-format.md "Timing" (text tags not
  counted; an animation or video not followed by a line holds for its
  loops or passes; a recorded voice line holds while it plays; choice
  screens and transitions not counted): every item once, as Play all
  routes reads it; the shortest reading from the opening to an ending;
  the main line outside every route; and each route of each decision,
  with nested decisions inside it. Items no reading reaches are listed
  apart.
- Speakers with their line counts and the narration count. Names that
  differ only in case or spacing, or by one letter (`Mei` and `Mai`),
  are flagged: often a typo or a mis-extracted speaker. A digit for a
  digit (`Guard 1`, `Guard 2`) is not flagged.
- The `characters` entries, the ones no speaker uses and the speakers
  without one; how many picture items have a dissolve, a fade or a cut.
- Text tag problems (an unknown or unclosed tag and the like) in lines,
  prompts, route labels and language files, with where each is.
- Files in the folder nothing references. The player's own files, the
  manifest and its script, the schema copies, the ledgers, the apps and
  licence and readme files are not listed.
- The 20 longest lines by shown characters, with id, speaker, length and
  their first 60 characters.
- Each decision the converter made from an `if` chain, from the build
  ledger: its id and kind, the chain as written, its route labels, and
  the languages whose words are English because the catalogue lacks
  them (`English words for: de`).
- For a game with translations, each language's coverage, counted as
  the validator counts it: strings translated of the base's, with the
  missing, stale, unchecked (no `from`) and long ones:

  ```text
  Translation coverage: 3 languages, base en
    de: 43 of 44 strings (97.7%); 1 missing, 1 stale, 0 unchecked, 0 long
    ja: 44 of 44 strings (100%); 0 missing, 0 stale, 0 unchecked, 0 long
    ar: 44 of 44 strings (100%); 0 missing, 0 stale, 0 unchecked, 0 long
  ```

`--json` prints the same report as one JSON object (the coverage under
`coverage`, `{}` for a game without translations). The exit status is
0 whenever the report ran, whatever it found, and 2 for bad arguments or
a folder without a readable manifest. A folder where a decision breaks
the span rules (a route not after its `after` item, two of its routes
overlapping, a `continueAt` not after every route end) has no
well-defined reading, so it gets no reading times: the report lists
those problems in their place, prints the rest, and exits 1.

#### kinetic routes

`kinetic routes` prints the branch structure as the branch map draws
it, as an indented outline: each stretch of items, each decision with
its prompt, where its line carries on and the decision it `follows`,
and under it each route with its label, result, item count, first and
last items, where it ends or rejoins and the earlier picks it takes
(`when`), nested decisions indented under their route; a following
decision also says which earlier picks no route takes, passing it on
to its `continueAt`. Decisions no
line reaches, `branches` entries the player drops, and items no reading
reaches are listed after it. `--dot` prints the same as Graphviz DOT,
`--json` as one JSON object; the exit status is as for `report`, except
that a decision breaking the span rules prints nothing but those
problems, on stderr, and exits 1.

```text
main line: 29 items
  items intro-title..branch-decide (27 items)
  decision outer after branch-decide, carries on at after-start: "Demo decision: which route?"
    1. route route1 "Route 1: continues the story": continuing, 5 items, route1-start..route1-end; joins at after-start
      items route1-start..route1-nest (2 items)
      decision nested after route1-nest, carries on at route1-end: "Nested decision inside Route 1:"
      ...
    2. route route2 "Route 2: an ending": ending, 2 items, route2-start..route2-end; an ending (the choice is offered again)
      items route2-start..route2-end (2 items)
  items after-start..after-end (2 items)
  the story ends at after-end
```

#### kinetic export

`kinetic export` prints the story as Markdown, in the outline's order,
to lay beside the `.rpy` source: each item as an anchor
(`<a id="ITEM"></a>`), its media and audio as HTML comments, and its
line as `Speaker: text`, `Speaker (thinks): text` or bare narration.
Text tags are read to the shown text and emphasis is dropped, not
written as Markdown asterisks, which are common in a game's own text.
Each choice lists its route labels, with the earlier pick each takes
for a decision that `follows` another, and a comment says what it
follows; each route follows under a
`## Route DECISION/ROUTE` heading and ends in a comment saying where it
leads. `--lang TAG` reads the texts, names, prompts and labels from that
language file, marking `[base] ` each string it lacks. `--out DIR`
writes `main.md` and one `DECISION.ROUTE.md` per route, each with the
choices and routes nested in it, in place of stdout. A decision
breaking the span rules stops it as it stops `routes`.

```text
<a id="route1-nest"></a>
Theo: Route 1, second line: the nested decision hangs off this one.

### Choice nested: Nested decision inside Route 1:

1. 1a: carries on with Route 1 (nested/nest-a, continuing: joins at route1-end)
2. 1b: comes back to this decision (nested/nest-b, return: returns to the choice)
```

### Several episodes, one game

A game released in episodes becomes one game: list the episodes in
story order before the output folder.

```sh
kinetic extract ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 \
    ~/games/RainyDay-Kinetic --title "Rainy Day" --story-id rainy-day
```

Episode 2 follows episode 1 in one story, item ids gain an `ep1-`/
`ep2-` prefix, and one `media/` folder stores identical files once.
Give `--title` and `--story-id`: without them both come from the first
episode (here its folder name, `Ep1`). Keep the episode order when you
add an episode later (append it), so existing ids and readers'
progress stay. In the example, episode 2 wraps its yard image, so this
run reports two `ep2-bg-yard-…` items dropped (`items skipped: 2`); the
next section fixes that. Rebuild with every episode, in the same order:

```sh
kinetic media rebuild ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 \
    ~/games/RainyDay-Kinetic
```

Reference: docs/extracting.md, "Several episodes, one game".

### A game that wraps its media: decoder hooks

Some games wrap or obfuscate their image or video files. The
extractor reports such a file as an `unsupported image format (...):
item dropped from manifest` note and counts it under `items skipped`.
Kinetic ships no game-specific decoders; you write one as a Python
function, a decoder hook, and pass it with `--decoder MODULE:FUNC`.

The hook gets the complete bytes of every media source the conversion
reads, loose file or `.rpa` member, before format detection:

- `def decode(data: bytes, source: dict) -> bytes | None`. `source` is
  `{"path": "game/images/a.png"}` for a loose file or
  `{"archive": "game/images.rpa", "member": "images/a.png"}` for an
  archive member.
- Return `None` for data that is not yours; it passes through
  unchanged.
- Return the decoded bytes for data you unwrapped.
- Raise for data you recognise but cannot decode (truncated,
  malformed). The run stops with exit 1, naming the hook and the
  source, and writes no manifest; nothing is silently skipped.

The worked example below unwraps an "EXTRA" wrapper: `EXTRA` plus three
bytes at the start, and ten junk bytes inserted at an offset that
depends on the file's length.

> **Illustrative only.** This formula shows the shape of a hook. It is
> modelled on a wrapper seen in a converted corpus game but is NOT a
> correct decoder for that game: its episodes 4-5 use an activation-dependent
> offset that this formula does not handle. A real game's hook is
> written for, tested on and shipped with that game's conversion
> package, never with Kinetic.

Save it as `~/games/rainy-kinetic/rainy_unwrap.py`, in the folder that
holds your conversion package for the game:

```python
"""Decoder hook for Rainy Day's "EXTRA" wrapper.

ILLUSTRATIVE ONLY: this formula shows the hook shape; it is not a
correct decoder for any real game.
"""

PREFIX = b"EXTRA"
HEAD = 8          # the prefix plus three bytes the wrapper adds
JUNK = 10         # bytes inserted at a length-dependent offset
STRIDE = 30477


def decode(data: bytes, source: dict) -> bytes | None:
    if not data.startswith(PREFIX):
        return None                       # not ours: leave it alone
    offset = max(20, ((len(data) - 18) // STRIDE) * STRIDE)
    if len(data) < offset + JUNK:
        raise ValueError(f"truncated EXTRA wrapper ({len(data)} bytes)")
    return data[HEAD:offset] + data[offset + JUNK:]
```

Pass it by module name, with its folder on `PYTHONPATH`, to both the
conversion and the rebuild:

```sh
PYTHONPATH=~/games/rainy-kinetic kinetic extract \
    ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 ~/games/RainyDay-Kinetic \
    --title "Rainy Day" --story-id rainy-day --decoder rainy_unwrap:decode
PYTHONPATH=~/games/rainy-kinetic kinetic media rebuild \
    ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 ~/games/RainyDay-Kinetic \
    --decoder rainy_unwrap:decode
```

Packaging rules:

- Keep the hook in one self-contained `.py` file next to your helper or
  conversion notes, and ship it with them. The ledger records the hook
  as given (`rainy_unwrap:decode`) and the sha256 of that one file, so
  code it imports from elsewhere is not covered.
- Name it by module name (as above) or by a path relative to where you
  run, never an absolute path: the ledger then reads the same on every
  machine. A rebuild matches a hook by function name and code hash, so
  it still finds a hook spelled differently, but a changed file is a
  mismatch.
- The hook runs inside the converter with its full trust: use only code
  you have read.
- Several `--decoder` hooks chain in the order given.

Reference: docs/extracting.md, "Decoder hooks".

### Writing your own converter: kinetic media ship

A game the extractor cannot read well (its own story format, screens
instead of `say` statements) gets a game-specific helper: your own
code builds the story, and `kinetic media ship` does all the media
work, with the same tools, policies, decoder hooks and
content-addressed `media/` layout as `kinetic extract`. The helper
writes `manifest.json` itself. It replaces `kinetic extract` for that
game, so ship into a folder of its own: below, an empty
`~/games/RainyDay-Kinetic` (delete the one the extractor made above).

Use the folder that holds every episode (`~/games/RainyDay`) as the
game root for every ship, and name sources relative to it, so one
media ledger covers all episodes and one root rebuilds them. Ids must
be unique across episodes. A request list per episode,
`~/games/rainy-kinetic/requests-ep1.json`:

```json
[
  {"id": "ep1-room", "kind": "image",
   "source": {"path": "Ep1/game/data/bg-room.png"}},
  {"id": "ep1-clip", "kind": "video", "startSeconds": 0.5,
   "source": {"path": "Ep1/game/data/clip.mp4"}},
  {"id": "ep1-rain", "kind": "audio", "loops": true,
   "source": {"path": "Ep1/game/audio/rain.ogg"}},
  {"id": "ep1-clip-sound", "kind": "audio", "loops": true,
   "source": {"path": "Ep1/game/data/clip.mp4"}}
]
```

A source inside an `.rpa` archive is
`{"archive": "Ep1/game/images.rpa", "member": "bg/room.jpg"}`. A
video's poster is the frame at `startSeconds` (default 0). An `audio`
request ships a sound file for a track by kinetic extract's rule: MP3,
M4A, WAV, FLAC and WebM as they are, Ogg Vorbis or Opus copied into
WebM, anything else re-encoded to Opus in WebM. Give `"loops": true`
for a track that loops (music, ambience, a video's sound): it then
never ships as MP3 or Opus, which loop off their sample, and is
re-encoded to AAC in M4A instead (docs/extracting.md, "Audio policy").
Its result's `durationSeconds` is measured by decoding the shipped
file, and its script ships beside it. An `audio` request of a video,
here `ep1-clip-sound`, ships the video's own soundtrack, for that
item's `videoSound`.
`requests-ep2.json` lists episode 2's sources the same way. Ship each
episode into the same folder, from the helper's folder:

```sh
cd ~/games/rainy-kinetic
PYTHONPATH=. kinetic media ship ~/games/RainyDay \
    ~/games/RainyDay-Kinetic --list requests-ep1.json \
    --decoder rainy_unwrap:decode
PYTHONPATH=. kinetic media ship ~/games/RainyDay \
    ~/games/RainyDay-Kinetic --list requests-ep2.json \
    --decoder rainy_unwrap:decode
```

A ship encodes on one worker per core by default. `--jobs N` changes
how many encodes run at once, and `--video-jobs N` how many of them
may be video transcodes (default: a quarter of `--jobs`). Lower
`--jobs` if the machine runs short of memory: each 1080p poster
encode needs about 0.12 GB. `--jobs 1` encodes one thing at a time.
The folder comes out byte-identical whatever the limits. A long ship
prints `progress: 5120/87000 (5.9%), 41m10s elapsed, ~10h58m left` to
stderr every 10 seconds. A killed ship writes no ledger. With the
reuse cache on (the default), a restart re-encodes nothing it
finished before. `rebuild` takes the same two options.

Each run prints `requests: 4; shipped: 4; skipped: 0` and merges into
`~/games/RainyDay-Kinetic/media-ledger.json`; shipping the same list
again changes nothing. That ledger's `requests` pair each request with
its `result`. A result with a `file` gives the manifest item's media
fields, or the track's; one without a `file` shipped nothing, and its
`decision` and `notes` say why. Your helper drops that item or track.

An audio request of a video ships nothing when the video has no audio
stream (decision `no audio`) or when its soundtrack is digital silence,
below -70 dB at its loudest (decision `silent`). Neither is an error:
the run still exits 0, the summary gains `; no sound: 1`, and a line
names the request:

```text
requests: 4; shipped: 3; skipped: 0; no sound: 1
  request 4 (Ep1/game/data/clip.mp4): no audio: no audio stream in clip.mp4: nothing shipped
```

So ask for every video's sound, and give `videoSound` only to the items
whose sound shipped and lasts to the item's range end (the validator
allows 0.05 s short). A sketch of reading the ledger
(`media_items.py`):

```python
import json


def media_items(folder):
    """Request id -> the media fields of its manifest item, and request
    id -> its audio track."""
    with open(f"{folder}/media-ledger.json", encoding="utf-8") as f:
        ledger = json.load(f)
    items, tracks = {}, {}
    for entry in ledger["requests"]:
        request, result = entry["request"], entry["result"]
        if "file" not in result:      # nothing shipped: say why
            print("not shipped", request.get("id"), result["decision"],
                  result["notes"])
            continue
        if request["kind"] == "image":
            items[request["id"]] = {"type": "image", "file": result["file"]}
        elif request["kind"] == "audio":
            tracks[request["id"]] = {
                "file": result["file"],
                "durationSeconds": result["durationSeconds"]}
        else:
            items[request["id"]] = {
                "type": "video", "file": result["file"],
                "poster": result["poster"],
                "durationSeconds": result["durationSeconds"],
                "startSeconds": request.get("startSeconds", 0)}
    return items, tracks
```

The result's `width` and `height` give the display size. The helper
then writes `manifest.json` with these items in story order and the
tracks under `audio.tracks`, names the tracks from its items' `audio`
(Sound, below), generates `manifest.js` (Generating manifest.js), and the
folder is validated, played and rebuilt like any other:

```sh
kinetic validate ~/games/RainyDay-Kinetic
PYTHONPATH=~/games/rainy-kinetic kinetic media rebuild \
    ~/games/RainyDay ~/games/RainyDay-Kinetic --decoder rainy_unwrap:decode
```

A media ledger rebuilds from its one game root (the folder holding the
episodes). Share the finished folder, and keep the helper folder
(hook, request lists, helper code) with it, so anyone holding the game
can rebuild it.

Reference: docs/extracting.md, "kinetic-media ship".

#### Regenerating JPEG posters as lossless ones

Posters are lossless: a `.png`, or a `.jxl` when that is smaller and
decodes to the same pixels. A folder shipped before that has `.jpg`
posters. To replace them, ship the same request lists into the same
folder again, then rebuild your manifest from the new results:

```sh
PYTHONPATH=. kinetic media ship ~/games/RainyDay \
    ~/games/RainyDay-Kinetic --list requests-ep1.json \
    --decoder rainy_unwrap:decode
```

Videos are not converted again: each one the ledger already records
for that source and recipe is re-hashed and reused, with or without
the reuse cache, so only the posters are made. Every result's `poster`
(and `width`/`height`) names the new file, and the summary ends with
`unreferenced posters: N kept`, the old JPEGs, which stay in `media/`
and in the ledger so the folder still rebuilds. Once your
`manifest.json` uses the new posters, run the same command again with
`--delete-unreferenced-posters` to delete them (it encodes nothing and
prints `unreferenced posters: N deleted`). Only poster files that no
request result, `manifest.json` or `build-ledger.json` in the folder
names are deleted; a request you did not re-ship keeps its JPEG. Then
run `rebuild` as below.

### Checking a folder with rebuild

`kinetic media rebuild` reads the folder's `build-ledger.json` and/or
`media-ledger.json`, finds every original source under the game
root(s), checks its sha256, runs the recorded steps again, and checks
each output's sha256 and the folder's `media/` (no file missing, extra
or altered). It never uses the reuse cache. Exit 0 and `rebuild OK`
mean every media file is exactly what this game and these tools make.

To verify a folder on another machine, that machine needs:

- the same platform (OS and architecture): the ledger records the
  platform that made the folder, since some recipes give other bytes
  on another CPU. Elsewhere the rebuild stops with `made on
  <platform>; rebuild there to verify` (exit 3). A folder whose ledger
  names no platform, from before ledgers recorded it, was made on
  `macos-arm64`. The ledger also records the ffmpeg binary's sha256,
  and a rebuild refuses tools that differ (exit 2);
- the Kinetic release that made the folder, installed and set up as in
  Installing Kinetic (or a checkout at the commit that made it; note
  the release or commit when you share a folder);
- the original game files, and the same decoder hooks.

Then run the same rebuild command with that machine's paths. Add
`--out DIR` to also write the rebuilt `media/` tree into `DIR`, which
reproduces a folder's media from its ledger and the game alone.

Rebuild the converter's folder, not the copy `kinetic assemble`
makes for play: that copy keeps the ledger but leaves out the sound
files, since the player reads only their scripts, so a rebuild there
fails each one as `absent from the folder`. The scripts are checked in
both: each must hold its rebuilt file's bytes.

Reference: docs/extracting.md, "kinetic-media rebuild".

### Checking posters before delivery

A video item's poster must be the frame at its `startSeconds`: the
player shows it in skip, rewind and under text lines. A helper that
ships a video once (at 0) and then uses it for items starting later
gets frame-0 posters on those items. Before you deliver a folder, check
every video item's poster against the ledger:

```sh
PYTHONPATH=~/games/rainy-kinetic kinetic media posters \
    ~/games/RainyDay ~/games/RainyDay-Kinetic --decoder rainy_unwrap:decode
```

Use the same game root and `--decoder` hooks as the ship. To check a
draft manifest kept outside the folder, add `--manifest
path/to/manifest.json`. A good run exits 0 and ends `posters: N video
items: N checked, N passed (...), 0 failed, 0 skipped (first frame)`.
Exit 1 lists each wrong poster on a `FAIL <id>: ...` line with the
item's `startSeconds`, the start the ledger records for its poster,
the pixel difference and the mean luma of the start frame and of the
poster; `dark start` there means the item starts on a black or nearly
black frame, so the poster may have been moved past a fade-in on
purpose. The check writes nothing.

To fix them, add `--fix` and say where the remap goes:

```sh
PYTHONPATH=~/games/rainy-kinetic kinetic media posters \
    ~/games/RainyDay ~/games/RainyDay-Kinetic --decoder rainy_unwrap:decode \
    --fix --remap ~/games/rainy-kinetic/poster-remap.json \
    --out ~/games/rainy-kinetic/poster-requests.json
```

It ships one poster per distinct video and `startSeconds` into the
folder, as `kinetic media ship` would (videos are reused, only posters
are made), and writes the remap: item id -> new poster. `--out` keeps
the requests it shipped. It does not touch your manifest: set each
remapped item's `poster` (or have your helper use the new results),
regenerate `manifest.js`, and run the check again, which now exits 0.
Running `--fix` again before you apply the remap changes nothing. An
item it cannot fix (`NOT FIXABLE <id>: ...`, for example a video the
ledger has no entry for) makes it exit 1; fix that item by hand.

To gate a single shipment rather than the whole folder, list its item
ids in a file (a JSON array of strings, or one id per line, with `#`
comment lines) and add `--items ~/games/rainy-kinetic/ep3-items.txt`.
Only those items are checked, and with `--fix` only they are shipped
and remapped. The summary starts `posters: 12 of 1504 video items
selected:`. The list may hold the shipment's text and image items too,
which are ignored, but an id that is not in the manifest stops the run
(exit 2) so a typo cannot pass the gate.

A hand-made folder that cannot decode to seek may keep first-frame
posters (docs/content-format.md, "Video playback ranges"): name those
videos with `--first-frame FILE` (a manifest `file` value, repeatable),
or pass `--first-frame-all`, and they are skipped.

For a quick look without the game files, add `--ledger
~/games/RainyDay-Kinetic/media-ledger.json` to the validator: it reads
the ledger only, decodes nothing, and prints a `warning:` line on
stderr for each poster the ledger records at another start or from
another source, and for each item starting after 0 whose poster it
records no start for. Warnings change the exit status only with
`--strict` (exit 3, Validating); the `kinetic media posters` check above
settles them.

Reference: docs/extracting.md, "kinetic-media posters" (the
validator's warning is under "The validator's cheap check").

### The reuse cache

Encoding (lossless JPEG XL at effort 9, transcodes, posters) is the
slow part of a conversion. `kinetic extract` and `kinetic media ship`
remember each encode in `kinetic-media-cache/`, in the caches folder of
an installed Kinetic (`~/Library/Caches/Kinetic` on macOS; Installing
Kinetic) or in `.tmp/` in a checkout, keyed by the bytes being encoded
(after decoder hooks), the recipe and the exact tools, so a re-run or a
later episode encodes nothing it has made before and writes the same
folder byte for byte.

- `KINETIC_MEDIA_CACHE=DIR` puts the cache elsewhere, for example on a
  bigger disk; `KINETIC_MEDIA_CACHE=off` turns it off for one run.
- Deleting it is always safe (`rm -rf
  ~/Library/Caches/Kinetic/kinetic-media-cache`, or `rm -rf
  .tmp/kinetic-media-cache` in a checkout); the next run encodes again.
  Do so to reclaim disk space; the cache only grows. Stored outputs are
  hash-checked when read, so a damaged cache never damages a folder.
- `rebuild` never reads it.

Reference: docs/extracting.md, "Reuse cache".

### When something fails

**`media self-test mismatch: the tools would not reproduce the pinned
output, refusing to convert`**, with one line per case such as
`imagecodecs (imagecodecs.jxl-lossless): expected …, got …`. The tools
on this machine do not make the pinned bytes, so a folder made here
would not match one made elsewhere. Install the wheel again (`pip
install --force-reinstall` with the release's wheel; in a checkout,
`.venv/bin/pip install -r requirements.txt --cache .tmp/pip-cache`)
and run `kinetic setup --force` (a fresh ffmpeg download). If it still
fails, the platform really differs (a different build of a wheel or of
ffmpeg): report it with the case lines, and do not `--repin` to make it
pass, since that would change the reference bytes for every machine.
The related refusals name their own fix: a missing install or a changed
binary (`run kinetic setup`), codec versions that differ from the pins
(`run pip install --force-reinstall <the Kinetic wheel>`, or the
checkout's `pip install -r requirements.txt` line), or a platform or
case not pinned yet (`... --pin`).

**`decoder hook rainy_unwrap:decode failed on game/data/bg-room.png:
ValueError: truncated EXTRA wrapper (13 bytes)`** (exit 1). Your hook
raised on that source. Either the file is damaged in this copy of the
game, or the hook does not cover this variant of the wrapper: fix the
hook, never make it return `None` for data it recognises. A hook that
cannot be loaded (`has no function 'decode'`, `cannot import`) is a
usage error (exit 2) before any work.

**`unsupported image format (...): item dropped from manifest`.** The
file is not an image Pillow reads and no plain wrapper was found in its
first 64 bytes. Usually a game-specific wrapper: write a decoder hook.

**`warning: ... poster failed for <video>: ffmpeg: <error>: item
dropped from manifest`.** No poster frame could be made, for example a
`startSeconds` past the end of the video, or a video ffmpeg cannot
decode. The item is dropped (a video never stands in as its own
poster). Fix the start time or the source.

**`remux failed for <video>: item dropped`** or **`transcode failed for
<video>: item dropped`**. The pinned ffmpeg could not copy the video
stream into MP4 (remux: H.264, HEVC or VP9 in a container Safari or
Chrome refuses) or re-encode it to H.264 (any other codec). Usually the
file is damaged; check that it plays in a desktop player, then replace
it. A remuxed video has no audio track, since the player plays videos
muted: the video's own sound ships separately as an audio track, its
item's `videoSound`, which kinetic extract requests for every video
(Converting, checking and playing one game, above).

**`kinetic-extract: <folder>/media/ab/ab12….png: existing file's sha256
is …, not the one its name gives; not replaced (remove it, or use
another output folder)`** (exit 1; `kinetic media ship` prints the same
line). The output folder already had a file under that content name,
and its bytes are not the ones the name promises: something altered
it. A correct existing file is reused untouched (it may be hard-linked
into another game), but a wrong one is never overwritten. Delete that
file if nothing else needs it, or convert into an empty folder, then
run again. `rebuild --out` reports the same problem as a `FAIL` line.

**`rebuild` exit 2.** It could not start: no ledger in the folder, a bad
game root, tools not ready, or `the ledger was made with other media
tools`, followed by each difference (`mediaTools Pillow: ledger
"12.0.0", now "13.0.0"`). Rebuild with the Kinetic release or commit
that made the folder, on the same OS and architecture, or convert the
game again with the current tools.

**`rebuild` exit 3.** `made on <platform>; rebuild there to verify`:
the folder was converted on another platform, whose CPU-dependent
recipes give other bytes, so this machine cannot check them. Rebuild
on that platform (a ledger without a platform means `macos-arm64`).

**`rebuild` exit 1.** Each problem is one `FAIL <output path>:
<problem>` line, then `rebuild FAILED: N problem(s)`:

| Problem | What to do |
| --- | --- |
| `missing source …` | Give the right game root(s), episodes in conversion order; a ship ledger takes the folder holding all episodes. |
| `source hash mismatch for …` | This copy of the game differs from the one converted (another release, a patch, a damaged file); use the same release. |
| `decoder hook missing: …` | Pass the hooks the conversion used, with `--decoder`. |
| `decoder hook mismatch: …` or `decode steps differ from the ledger …` | The hook's code changed since the conversion; use the version shipped with the folder. |
| `unsupported step '…'` | This Kinetic cannot run a recorded step; use the commit that made the folder. |
| `step … failed: …` | ffmpeg, Pillow or libjxl failed on the source; check the setup self-test passes. |
| `output mismatch: …` | The tools made other bytes; re-run setup, and rebuild with the commit that made the folder. |
| `script mismatch: ...` | On a sound file's `.js`: the file rebuilt right, but the script made from it is not the one the ledger records, so the ledger was edited or another Kinetic wrote it; rebuild with the commit that made the folder. |
| `not in the ledger` | A file in `media/` no ledger lists, often left by converting into a non-empty folder; convert into an empty folder. |
| `absent from the folder` or `folder file differs from the ledger: …` | The folder's `media/` lost or altered a file. Copy the folder again, or rebuild with `--out DIR` (a new folder) and copy `DIR/media/.` over the folder's `media/`. Every sound file is absent from an assembled copy: rebuild the converter's folder instead. |
| `…: existing file's sha256 is …, not the one its name gives; not replaced …` | With `--out DIR`, a file already in `DIR` under that content name holds other bytes; it is never overwritten. Delete it, or rebuild into a new `DIR`. |

Reference: docs/extracting.md, "kinetic-media rebuild".

## Hand-authoring a content folder

### Layout

The folder holds everything the novel needs. There are no absolute paths
and no network access at play time:

```text
my-novel/
  manifest.json    # source of truth, written by hand
  manifest.js      # generated shim, one command, see below
  manifest.schema.json  # optional: the schema, for your editor (Manifest)
  *.jpg, *.mp4     # media, named per the conventions shown below
                   # (optionally under a subfolder: media/ab/window-004.jpg)
  *.m4a, *.mp3     # sound, if the game has any (Sound, below)
  *.m4a.js         # beside each sound file, its bytes as a script
```

`index.html` and `app.js` are the player bundle, copied in as the last
step before playing (see "Playing the folder"). A content folder without
them is still valid input for the validator.

### Manifest

`manifest.json` carries `schemaVersion` (1), an optional `storyId`, an
optional `title`, an optional `version`, the display `width` and
`height` in pixels, and
`items` in play order. The `storyId` names the story itself (lowercase
letters, digits, `-`, `_`, starting with a letter or digit, at most 64
characters, such as `rainy-day-1`): the player saves the reader's
progress and bookmarks under it, so they survive moving or renaming the
folder, and a progress file a reader exports from the Esc screen imports
only into the story with the same ID. Pick one per story and keep it
across updates; without one, progress is tied to the folder's location,
and adding one later carries that progress over on the next load. The
`title` is the game's name as readers see it (any text up to 200
characters, such as `"Rainy Day"`): the player shows it as a heading at
the top of the Esc help screen and as the browser tab's title. Without
one the help screen has no heading and the tab reads `Kinetic`. The
`version` is your game's own release as you name it (any text up to 40
characters, such as `"1.2"`, `"0.9 beta"` or `"Episode 3"`): the Esc
screen shows it after the `title` heading, smaller and dimmer, or alone
where the heading would be when there is no `title`. Without one nothing
is shown. It is not Kinetic's version, which the Esc screen shows on
its own, small in the bottom-right corner (Upgrading to a newer
Kinetic). Each item has a unique
`id` (letters, digits, `-`, `_`, starting with a letter or digit), a
`type`, and the fields its type requires:

- `image`: `file`, one image at display resolution. `.jpg`, `.png`,
  `.webp`, `.gif`, and `.jxl` are allowed; `.jxl` needs Chrome/Edge
  117+, Safari 17+, or Firefox 133+.
- `animation`: `frames` (at least two, at display resolution, in play
  order), `fps` greater than 0, `loopCount` of at least 1. Optionally
  set `frameSeconds`, one display time in seconds (greater than 0) per
  frame, to time the frames unevenly; keep an `fps` near their average,
  which a player older than 1.15.0 plays them at. Set `holdLastFrame:
  true` to stop on the last frame after the loops, under the lines
  after it too, instead of looping on.
- `video`: `file` (any video file, any extension; playability is
  the browser's call, so pick a format Safari and Chrome both play:
  H.264 in `.mp4`/`.mov`/`.m4v`/`.3gp`, HEVC tagged `hvc1` in
  `.mp4`/`.mov`/`.m4v`, VP9 in `.mp4`/`.webm`/`.mkv`, VP8 in
  `.webm`/`.mkv`; docs/content-format.md has the measured table),
  `poster` (a display-resolution still, the frame
  at `startSeconds` and the first frame without a range, also shown
  in skip and rewind), and `durationSeconds` greater than 0, the
  file's total duration. Optionally set `loopCount` (at least 1,
  default 1) to play the video repeatedly and `holdSeconds` (greater
  than 0) for an explicit display duration; `durationSeconds` stays
  required either way. When a long video opens a brief dialogue
  chain and must get seen, set `minPlaySeconds` (greater than 0):
  in auto mode the player waits at the end of the chain until that
  many seconds have passed since the video became current. Manual
  advance and skip transitions stay immediate, and outside a chain
  the field does nothing.
- `text`: no media fields; only `id`, `type`, and the optional
  `speaker`, `text`, and `thought`. It shows the visual of the nearest
  earlier media item, and that video or animation keeps looping
  underneath it (an animation with `holdLastFrame` plays its loops and
  then holds its last frame).
  A `text` chain advances on text holds alone, never gated on media
  end. The first item may not be `text`, and a `text` item needs a
  media item before it.

Any item may also carry `speaker` and `text` for the overlay; no `text`
means a bare visual with nothing drawn. A line may be marked with
`thought: true` to show it as the `speaker`'s unspoken thoughts rather
than spoken dialogue; the player draws the two differently. `thought`
defaults to `false` and needs a non-empty `text`. Beyond these, an item
takes only `transition` on a picture item (Transitions, below) and
`audio` (Sound, below). Media paths are relative to the folder, use
POSIX separators, and contain no spaces and no `..` segments.

A complete minimal manifest: one image, one animation, one video, and
two `text` lines that run over the looping video:

```json
{
  "$schema": "./manifest.schema.json",
  "schemaVersion": 1,
  "storyId": "rainy-day",
  "title": "Rainy Day",
  "version": "1.0",
  "width": 1280,
  "height": 720,
  "items": [
    {
      "id": "title-001", "type": "image", "file": "title-001.jpg",
      "speaker": "Mei", "text": "You're early today."
    },
    {
      "id": "rain-002", "type": "animation", "fps": 12, "loopCount": 2,
      "frames": ["rain-002.f000.jpg", "rain-002.f001.jpg"],
      "text": "Rain began against the window."
    },
    {
      "id": "intro-003", "type": "video", "file": "intro-003.mp4",
      "poster": "intro-003.poster.jpg", "durationSeconds": 18.4
    },
    {
      "id": "line-004", "type": "text", "speaker": "Mei",
      "thought": true,
      "text": "The street glowed under the awning."
    },
    {
      "id": "line-005", "type": "text",
      "text": "Neither of us spoke for a while."
    }
  ]
}
```

The two `text` items display `intro-003`'s visual while its video loops
underneath, and each holds for its text alone. The first carries
`thought: true`, so the player shows it as Mei's unspoken thoughts.
Neither the video's end nor its loops gate an advance while the chain of
`text` items lasts.

The first key, `$schema`, is for your editor; the player and the
validator ignore it. Copy the schema into the folder once: in a
checkout, from its root,

```sh
cp docs/content-schema.json my-novel/manifest.schema.json
```

and without one, from a folder `kinetic extract` made (it writes the
copy), or as `docs/content-schema.json` from the release on GitHub. VS
Code, and other editors that read `$schema`, then check `manifest.json`
against it as you type and complete its field names, offline. The copy
is the schema of the Kinetic you copied it from; `kinetic upgrade`
replaces it with the newer one when you upgrade (Upgrading to a newer
Kinetic), and `kinetic assemble` leaves it out of the folder readers get
(Playing the folder). The key may stay in the manifest without the file:
an editor that finds no schema checks nothing.

The item ids drive the file names: `<id>.<ext>` for an image or a
video, where `ext` is the true shipped format (`jpg`, `png`, `webp`,
`jxl`, or `gif` for images; the container's usual extension, such as
`mp4`, `mov`, `m4v`, `3gp`, `webm` or `mkv`, for video),
`<id>.fNNN.jpg` for animation frames numbered from `f000`, and
`<id>.poster.jpg` for a video poster. Browser-compatible
originals are preserved byte-identical, with no forced re-encode.
These names are defaults for a folder you write by hand, not a
one-file-per-item rule: several items may reference the same file, and
you may name your files differently. (The converter names its files by
content instead; see "Converting a Ren'Py project" above.) The names above
are the last segment of the path: a `file`, `poster`, or `frames` entry
may sit in a subfolder of the content folder, such as
`media/ab/window-004.jpg`. The path stays relative to the content
folder: forward slashes, no leading `/`, no `..`, no drive letter, no
backslash, and the last segment keeps the flat name. Subfolders are
never a requirement; a folder you author by hand may stay flat. A folder may also
carry extra unreferenced files, such as the converter's build ledger; the
player and the validator ignore them.

A video item may play a sub-range of its file: `startSeconds` (at least
0, default 0) and `endSeconds` (greater than `startSeconds`, default
`durationSeconds`). Both are exact fractional seconds, never rounded;
each pass of the video ends at `endSeconds`. A range that runs to the
file's end can leave `endSeconds` out, and any value past the start of
the file's last frame also ends each pass at the file's end, so a time a
float step below `durationSeconds` still loops. Several items may
reference the same file at different ranges, so one clip can serve
several beats. To count in frames instead, store `startFrame / fps` and
`endFrame / fps` as the seconds; the player never sees frame numbers.

A looping video may restart its later passes somewhere else:
`loopStartSeconds` (at least 0, default `startSeconds`) is where
playback resumes once a pass reaches `endSeconds`, so a clip with an
intro plays the intro once and skips it on every loop-back. It is an
exact fractional second like the rest, and must stay below the range
end; coming back to the item later plays the intro again. The poster
is unaffected and stays the frame at `startSeconds`.

### Camera views in one video: segments

One video file may hold several camera views joined by camera moves: a
scene shot from the door, then the window, then the table, with lines
over each. Mark the views with the video item's optional `segments`, so
that after the item's lines Space shows the views one by one before it
leaves the item, and the reader can step back and forth between them.
Without `segments` the first Space after the last line leaves the whole
video.

`segments` is a list of views in file order, each
`{"startSeconds", "loopStartSeconds", "endSeconds"}` with
`loopStartSeconds` optional and no other keys. A view plays once from
its `startSeconds` to its `endSeconds`, then loops from its
`loopStartSeconds` (default its `startSeconds`) to its `endSeconds`
until the next step. A last view whose `endSeconds` lies past the start
of the file's last frame (`durationSeconds`, or a float step below it)
loops at the file's end, as a range does. Only a `video` item takes
`segments`. The validator checks:

- the list is not empty;
- each `startSeconds` is at least 0;
- each `endSeconds` is greater than its `startSeconds` and at most the
  item's `durationSeconds`;
- each `loopStartSeconds` is at least 0 and less than its `endSeconds`;
  below `startSeconds` is allowed;
- each view starts at or after the end of the one before. Views may
  touch: one ending at `8.04` and the next starting at `8.04` is fine.

The times are seconds in the file, not in the item's range: a view may
lie outside the item's `startSeconds`..`endSeconds`. They are compared
exactly, with nothing rounded, as the range is.

The converter does not write `segments`; add them yourself from the
view timings you have (the original game's camera list, an editor's
markers). Copy the times exactly as they are, digits and all: when one
view's end and the next view's start are the same number in your list
(`16.479999999999997` included), the views touch and pass, while a
rounded or retyped copy may overlap by a hair and fail. A view whose
loop restarts before its camera move into it has ended takes that
restart as its `loopStartSeconds`, not as its `startSeconds`:
starting the view there would overlap the view before.

This item loops the whole 24-second file from 0 under its lines, which
start at its second view; its third view's loop restarts at 16.3 s,
before the camera move into it ends at the second view's end:

```json
{
  "id": "harbor-012", "type": "video", "file": "harbor-012.mp4",
  "poster": "harbor-012.poster.jpg", "durationSeconds": 24,
  "startSeconds": 8.04, "loopStartSeconds": 0,
  "segments": [
    {"startSeconds": 0, "endSeconds": 8.04},
    {"startSeconds": 8.04, "endSeconds": 16.479999999999997},
    {"startSeconds": 16.479999999999997, "loopStartSeconds": 16.3,
     "endSeconds": 24}
  ]
}
```

Had the third view started at its loop start, the validator would say:

```text
manifest.json: items[0].segments[2].startSeconds: must not be before segments[1].endSeconds 16.479999999999997 (found 16.3)
```

What the reader gets:

- The lines come first. Space steps views only on the last item of the
  video's chain: the last `text` item after the video, or the video item
  itself when no lines follow it.
- There, the first Space goes to the first view that starts after
  wherever the video has got to, and each later Space to the next view.
  The video jumps to the view's start, plays it and loops it. After the
  last view, Space leaves the item as it would without `segments` (a
  decision hanging off the item opens then). The video's own sound
  (`videoSound`; Sound, below) follows each view and loops with it.
- On that same item, Right steps to the next view but never leaves the
  item, and Left steps to the view before (before any step, the view
  before the one playing). The Esc screen's help lists them as `← →`,
  after Space.
- Each step shows "View n of m" in a small pill for about 1.6 s, without
  blocking keys; `n` counts from 1.
- Nothing else steps views: auto-forward, skip, a choice and Play all
  routes' automatic pick leave the item as before, and the arrows do
  nothing in auto-forward or skip, on a choice, under the Esc screen or
  the branch map, or on any other item. Once a view is showing, turning
  auto-forward on moves on after the line's text hold.
- Everything else plays the item as before: the poster (still the frame
  at the item's `startSeconds`), the wheel, bookmarks, seen marks, the
  branch map, a reload and coming back to the item (which play the
  item's own range again, no view active).

docs/content-format.md, "Video segments", has the full rules.

### Branches

A `branches` array adds optional routes inside the linear item list.
Each entry is a decision that fires when the item named by its
`after` settles: the player shows the `prompt` above a numbered list
of route labels. A route's `start` and `end` name the inclusive,
contiguous run of items it plays. The continuing route is named by
`continuingRoute` and proceeds to `continueAt`; every other route is
an `ending` (the default: its last item IS the ending), declares
`result: "return"` (its end offers the choice again), or declares
`result: "continue"` (its end also proceeds to `continueAt`, for
alternatives that all lead into one shared scene: write the scene once,
at `continueAt`, not after each route). There is no implicit join; a
`"continue"` route needs `continuingRoute`. Two different
milestones decide what a re-opened decision shows: a route row's seen
mark needs only ENTERING that route, while the "Return to main route"
row appears only once the reader has played the `continuingRoute`
through to its end at least once - a route entered and abandoned opens
nothing, and until the continuing route is finished, re-openings offer
routes only. Readers do not have to answer: "Play all routes" is on by
default, so each choice counts down and the player plays every route,
shortest first, then `continueAt` (a `"continue"` route's end offers
the choice again while a route is unplayed); a reader who turns it off
on the Esc screen picks routes themselves. Full semantics
are in docs/content-format.md § Branches; the validator checks every
id, reference, and span.

The worked example below: a lead-in, a decision with one continuing
route and one ending route, and a nested mini-decision inside the
ending route.

```text
intro-001 -> line-002 -> meet-003 --[afternoon: fires on settle of meet-003]

  route "cafe" (ending)                cafe-004 .. cafe-008
    cafe-004 -> cafe-005 --[cafe-choice: fires on settle of cafe-005]
        route "stay"  (ending)   tea-006 --+
        route "leave" (ending)   tea-007 --+--> cafe-008  (continueAt)
  route "home" (continuingRoute)           home-009 -> home-010
                                                       |
    afternoon continueAt: -----------------------------+--> epilogue-011
```

```json
{
  "schemaVersion": 1,
  "storyId": "branches-example",
  "title": "Branches example",
  "width": 1280,
  "height": 720,
  "items": [
    {
      "id": "intro-001", "type": "image", "file": "intro-001.jpg",
      "speaker": "Mei", "text": "You're early today."
    },
    {
      "id": "line-002", "type": "text",
      "text": "The afternoon stretched out ahead of us."
    },
    { "id": "meet-003", "type": "image", "file": "meet-003.jpg" },
    {
      "id": "cafe-004", "type": "image", "file": "cafe-004.jpg",
      "text": "We took the corner table at the cafe."
    },
    {
      "id": "cafe-005", "type": "image", "file": "cafe-005.jpg",
      "speaker": "Mei", "text": "They're closing the terrace soon."
    },
    {
      "id": "tea-006", "type": "image", "file": "tea-006.jpg",
      "text": "We stayed for tea while the lights came on."
    },
    {
      "id": "tea-007", "type": "image", "file": "tea-007.jpg",
      "text": "We left before the terrace chairs went in."
    },
    {
      "id": "cafe-008", "type": "image", "file": "cafe-008.jpg",
      "text": "Back inside, the rain had started."
    },
    {
      "id": "home-009", "type": "image", "file": "home-009.jpg",
      "text": "We walked straight home under one umbrella."
    },
    {
      "id": "home-010", "type": "text", "speaker": "Mei",
      "text": "Same time tomorrow?"
    },
    {
      "id": "epilogue-011", "type": "image", "file": "epilogue-011.jpg",
      "text": "Whatever the afternoon held, the evening was ours."
    }
  ],
  "branches": [
    {
      "id": "cafe-choice", "after": "cafe-005",
      "prompt": "Stay for tea, or leave?",
      "routes": [
        { "id": "stay", "label": "Stay for tea",
          "start": "tea-006", "end": "tea-006" },
        { "id": "leave", "label": "Leave before they close",
          "start": "tea-007", "end": "tea-007" }
      ],
      "continuingRoute": "stay", "continueAt": "cafe-008"
    },
    {
      "id": "afternoon", "after": "meet-003",
      "prompt": "How does the afternoon go?",
      "routes": [
        { "id": "cafe", "label": "To the cafe",
          "start": "cafe-004", "end": "cafe-008", "result": "ending" },
        { "id": "home", "label": "Straight home",
          "start": "home-009", "end": "home-010" }
      ],
      "continuingRoute": "home", "continueAt": "epilogue-011"
    }
  ]
}
```

`meet-003` is the last item before the choice; the two `text` lead-in
items and `epilogue-011` play once regardless of which route ran.
Inside the `cafe` route, `cafe-005` fires the nested `cafe-choice`
decision, whose `continueAt` (`cafe-008`) ends the enclosing route.
`home-009`/`home-010` form the continuing route, so after them play
proceeds to `epilogue-011`; the `cafe` route declares
`result: "ending"`, so its last item IS that route's ending. To mark a
scene change, put a title image or a `text` item at a route's start or
end, and give the next picture a `transition` (Transitions, below) to
crossfade into it. The validator
accepts this manifest; `tools/data/branches-example` carries exactly
this folder.

A decision whose content depends on an earlier pick, as a Ren'Py `if`
on the variable a choice set does, can name that earlier decision in
`follows` (a decision whose `after` comes before its own, not itself
and not one enclosing it). Each of its routes then gives `when`, the
ids of the earlier decision's routes it belongs to; no id is in two
routes' lists, and at most one route has no `when` and takes the rest.
With Play all routes off it shows no choice: the route matching the
reader's last pick there starts at once, as a pick, or, when no route
takes that pick, the story goes on at `continueAt`, so such a decision
needs `continuingRoute` and `continueAt`. With no pick known it is an
ordinary choice, and with Play all routes on it is an ordinary decision
whose matching route plays last. A player older than 1.15.0 ignores
both fields and shows an ordinary choice. After the example's
`cafe-choice`, for instance:

```json
{
  "id": "after-cafe", "after": "cafe-008", "follows": "cafe-choice",
  "prompt": "Which fits your story so far?",
  "routes": [
    { "id": "had-tea", "label": "If you chose: Stay for tea",
      "start": "tea-thanks-009", "end": "tea-thanks-009",
      "result": "continue", "when": ["stay"] },
    { "id": "left", "label": "If you chose: Leave before they close",
      "start": "rain-010", "end": "rain-010", "when": ["leave"] }
  ],
  "continuingRoute": "left", "continueAt": "walk-011"
}
```

### Text tags

A line may carry Ren'Py's text tags, which the player reads as it draws
the line:

- `{i}`...`{/i}` italic, `{b}`...`{/b}` bold, `{u}`...`{/u}` underlined
  and `{s}`...`{/s}` struck through, nested as you like.
- `{p}` starts a new line.
- `{w}`, `{nw}`, `{fast}` and `{cps=N}`, which only time Ren'Py's
  typing, are left out.
- Ren'Py's other tags (`{color}`, `{size}`, `{font}`, `{a}` and the
  rest) are left out with their text kept.
- `{{` is a literal `{`.

```json
{
  "id": "porch-002", "type": "image", "file": "porch-002.jpg",
  "speaker": "Mei", "text": "You're {i}early{/i} today.{p}{b}Again.{/b}"
}
```

Tags work in `text`, decision `prompt`s, route `label`s and their
translations; a speaker name, the `title` and the `version` are drawn
as written. Emphasis is built from the tags, never read as HTML, so a
`<` in a line shows as written. Reading time counts what is shown, not
the tags (docs/content-format.md, "Timing"). The validator warns,
without failing, about an unknown tag, an emphasis tag never closed
and a closer with nothing open, and `kinetic report` lists them with
where each is. An older player shows the braces as written.
docs/content-format.md, "Text tags", has the full table.

### Speaker colours

The optional top-level `characters` gives a speaker a colour for the
name, for the lines, or both, keyed by the speaker exactly as the
items' `speaker` writes it:

```json
"characters": {
  "Mei": { "nameColor": "#e6b566", "textColor": "#f6dca8" },
  "Old Theo": { "nameColor": "#7fd6c2" }
}
```

Each colour is `#` and six hex digits, in either case; a colour left
out is the player's own, the gold name and the light text. Narration,
a line with no speaker, is never coloured. A coloured thought takes
its speaker's `textColor`, stays italic and is drawn dimmer, so it
still reads apart from speech. A language file changes only the name
drawn, so a translated name keeps its colours. The validator warns
about a key no item's `speaker` uses, and about a colour whose contrast
with the text band is below 4.5:1, which is hard to read over a bright
picture. An older player draws every speaker alike.
docs/content-format.md, "Characters", has the rules.

### Transitions

A picture item (`image`, `animation` or `video`) may set `transition`,
how its picture replaces the one on screen before it. Without one the
picture cuts, as it always has. There are two kinds:

```jsonc
{ "id": "rain-001", "type": "image", "file": "rain-001.jpg",
  "transition": { "kind": "dissolve", "seconds": 1 } }
{ "id": "title", "type": "image", "file": "title.jpg",
  "transition": { "kind": "fade", "out": 0.5, "hold": 0.25, "in": 1 } }
```

- `dissolve`: the new picture fades in over the old one over
  `seconds`, above 0 and at most 5.
- `fade`: the old picture goes to black over `out`, the black holds for
  `hold`, and the new picture comes in over `in`; each is 0 to 5
  seconds, and `out` or `in` is above 0.

A transition never holds up the reader. The item's text shows at once
and only the picture changes over time; a key pressed during it ends it
and does its job; auto-forward's hold starts when the item shows. Only
reading on runs one (Space, auto-forward, a pick on a choice): skip,
the wheel, jumps (the branch map, bookmarks, `e`, `u`, `#start`), a
reload and a reader's reduced-motion setting cut. A `text` item takes
no transition, and an older player cuts. docs/content-format.md,
"Transitions", has the rules.

### Title, credits and content warnings

Kinetic has no title, menu or credits screen of its own: opening a game
goes straight to its first item (docs/player.md, "No title or menu
screens"). A content warning, a title card and credits are items like
any other, at the start or the end of the story:

- **A content warning** comes first: an image (a plain card, or the
  cover) with the warning as its text. A new reader sees it before
  anything else; after that the game opens where they left it, and Tab
  skips it once it has been read.
- **A title card**: an image with the title drawn into the picture and
  no text, so nothing covers it. With no text it holds for 1.5 s in
  auto-forward (docs/content-format.md, "Timing"); a `fade` brings it in
  from black.
- **Credits** at the end: an image with the credits as its text, and
  `text` items after it for more, one screen each. Put them after the
  last item every reading reaches. A route that is an ending (Branches,
  above) ends the story where it ends, so give it credits items of its
  own at its end if it needs them.

A converted game's own warning or credits often sit in a label the
story never jumps to, such as Ren'Py's `splashscreen`; the walk leaves
those out, and `--also-label NAME` walks such a label after the story
(What the converter carries, above). Write a warning that must come
first as items at the start of `items`.

A whole game with all three, which `kinetic validate` accepts and
`kinetic check --steps all` walks from the warning to the thanks:

```json
{
  "schemaVersion": 1,
  "storyId": "rainy-day",
  "title": "Rainy Day",
  "width": 1280,
  "height": 720,
  "characters": {
    "Mei": { "nameColor": "#e6b566", "textColor": "#f6dca8" }
  },
  "items": [
    {
      "id": "warning", "type": "image", "file": "black.jpg",
      "text": "{b}Content warning{/b}{p}This story mentions the death of a parent."
    },
    {
      "id": "title", "type": "image", "file": "title.jpg",
      "transition": { "kind": "fade", "out": 0.5, "hold": 0.25, "in": 1 }
    },
    {
      "id": "rain-001", "type": "image", "file": "rain-001.jpg",
      "transition": { "kind": "dissolve", "seconds": 1 },
      "speaker": "Mei", "text": "You're {i}early{/i} today."
    },
    {
      "id": "porch-002", "type": "image", "file": "porch-002.jpg",
      "speaker": "Mei", "thought": true,
      "text": "He always was, when it rained."
    },
    {
      "id": "credits", "type": "image", "file": "black.jpg",
      "transition": { "kind": "fade", "out": 1, "hold": 0.5, "in": 0.5 },
      "text": "{b}Rainy Day{/b}{p}Story and pictures: the Rainy Day team"
    },
    {
      "id": "credits-thanks", "type": "text",
      "text": "Thank you for reading."
    }
  ]
}
```

### Sound

Sound is optional; a manifest without it plays silent and shows no sound
controls. Declare each audio file once as a track under a top-level
`audio.tracks`, with its `file` and `durationSeconds`, then name tracks
from an item's `audio`: its `music`, its `ambience` (the whole set of
loops from that item on), one-shots in `sfx`, a `voice` line, and on a
video item the video's own soundtrack as `videoSound`, since videos always
play muted. docs/content-format.md, "Audio", has every field, an example,
and the rule for what plays at an item after a decision: no item needs to
repeat the sound of the one before it. In a browser the sound starts at
the reader's first key or click, and the Mac and Windows apps play it
from launch (Playing the folder).

Use `.mp3`, `.m4a` (AAC), `.wav`, `.flac` or `.webm` (Vorbis or Opus)
files. An Ogg file passes the validator with a warning, because Safari
before 18.4 plays no Ogg and WebKit's decode of Vorbis in Ogg loses its
first 128 samples; copy its stream into WebM instead, which changes no
sample:

```sh
ffmpeg -i rain.ogg -map 0:a:0 -c:a copy rain.webm
```

A track that loops (music, unless it sets `loop: false`; ambience; a
video's `videoSound`) belongs in AAC (`.m4a`), Vorbis in WebM, WAV or
FLAC. MP3 and Opus in WebM decode with their start shifted in WebKit or
Chrome, so such a loop may click at each wrap, and the validator warns
(docs/content-format.md, "Loop-safe formats"). Re-encode such a loop,
here an MP3, to AAC:

```sh
ffmpeg -i theme.mp3 -map 0:a:0 -c:a aac -b:a 192k theme.m4a
```

One-shots and voice lines can stay MP3 or Opus.

Beside each sound file the folder needs its script, `<file>.js`: the
player reads the file's bytes from it, because a browser fetches nothing
over `file://` (docs/content-format.md, "The script beside each audio
file"). `kinetic assemble` writes every missing one when it
assembles the folder (Playing the folder, below), and leaves the sound
files themselves out of the folder it assembles, since the player reads
only the scripts; your content folder keeps both. To write them
yourself, run this inside the content folder, naming each sound file as
its track's `file` does:

```sh
for f in theme.m4a rain.webm door.mp3; do
  printf '__kineticAudio("%s","%s");\n' "$f" "$(base64 < "$f" | tr -d '\n')" > "$f.js"
done
```

Write it again after you change a sound file: the validator rejects a
script that no longer holds its file's bytes.

`durationSeconds` is the track's length as decoded; the player never
reads the file's own. It sets how long a voice line holds auto-forward
and where a track with a start or loop point loops. A header can misstate
it: a VBR MP3's can be far off (docs/extracting.md, "Audio policy"), and
ffprobe's `format=duration` read the demo's MP3 tracks 24-32 ms over and
its WebM tracks 2-8 ms over. `kinetic media ship` with `"kind": "audio"`
requests measures it by decoding, copies Ogg into WebM, ships a request
with `"loops": true` in a loop-safe format and writes the scripts for
you (Writing your own converter: kinetic media ship, above).
`fixtures/audio-demo` in a checkout, built by `.venv/bin/python
fixtures/build_audio_demo.py`, is a worked folder with every field.

### Preparing the media

Every image, frame, and poster must be exactly the manifest's width and
height. The commands below use ffmpeg and the example's 1280x720; run
them inside the content folder.

One image, from a still of any size:

```sh
ffmpeg -i photo.png -frames:v 1 -q:v 2 \
  -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" \
  title-001.jpg
```

An animation frame set, numbered from 0 in play order:

```sh
n=0
for f in walk/*.png; do
  ffmpeg -y -i "$f" -frames:v 1 -q:v 2 \
    -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" \
    "$(printf 'rain-002.f%03d.jpg' "$n")"
  n=$((n + 1))
done
```

A video the browser already plays needs no re-encode: copy it in as
`<id>.<ext>` and read back its runtime. This one is transcoded to
faststart H.264 at display resolution, with its poster taken from the
first encoded frame and its runtime read back for `durationSeconds`:

```sh
ffmpeg -i clip.mov \
  -vf "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720" \
  -c:v libx264 -pix_fmt yuv420p -movflags +faststart intro-003.mp4
ffmpeg -i intro-003.mp4 -frames:v 1 -q:v 2 intro-003.poster.jpg
ffprobe -v error -show_entries format=duration \
  -of default=noprint_wrappers=1:nokey=1 intro-003.mp4
```

Previews named `<id>.thumb.jpg`, no wider than 320 pixels, are optional
by hand: the manifest never references them, and bookmarks capture the
visible surface at run time. To derive one anyway:

```sh
ffmpeg -i title-001.jpg -vf "scale=min(320,iw):-2" title-001.thumb.jpg
```

### Generating manifest.js

The player reads the manifest through `manifest.js`, a classic script
containing exactly `window.KINETIC_MANIFEST = <manifest JSON>;`, so the
folder plays over `file://` without fetch. One command builds it, run
inside the content folder:

```sh
printf 'window.KINETIC_MANIFEST = %s;\n' "$(cat manifest.json)" > manifest.js
```

The validator rejects a shim whose JSON differs from `manifest.json`, so
regenerate the shim after every edit.

A translated game's language files, `lang/<tag>.json`, each have a
script beside them in the same way, `lang/<tag>.js` containing exactly
`window.KINETIC_LANGUAGES["<tag>"] = <the file's JSON>;`
(docs/content-format.md, "Translations"). One command writes them all:

```sh
for f in lang/*.json; do t=$(basename "$f" .json); printf 'window.KINETIC_LANGUAGES["%s"] = %s;\n' "$t" "$(cat "$f")" > "lang/$t.js"; done
```

### Validating

Run the validator on the folder:

```sh
kinetic validate my-novel
```

A clean run prints nothing and exits 0. A broken folder prints one line
per problem, shaped like
`manifest.json: items[1].fps: must be greater than 0 (found 0)`, plus a
problem count on stderr, and exits 1. The validator checks the schema
plus the filesystem invariants in docs/content-format.md: every
referenced file exists inside the folder, item ids are unique, each
video's playback range fits inside its `durationSeconds`, every track an
item names exists, each sound file has its script holding its bytes (or
ships as that script alone, as an assembled folder does), and a present
`manifest.js` embeds JSON equal to `manifest.json`. An Ogg track, a
looping track in MP3 or Opus in WebM, and a track no item uses each
print a `warning:` line on stderr, then a count, which leaves the exit
status alone, as do a text tag problem and a `characters` key no
speaker uses or a colour too dim to read (Text tags and Speaker
colours, above). A translated game's language files are checked too: a
missing or stale translation is a warning (docs/content-format.md,
"Rules and validator invariants"). Each language's coverage is not
printed, so a game with translations, even complete ones, is silent
when clean; `kinetic report` and `--json` give the coverage.

A gate, a script or an agent that must stop on a bad folder, can rely
on that silence and on the exit status. With `--strict`, warnings of
any kind, and no problems, exit 3:

```sh
kinetic validate my-novel --strict
```

| exit | meaning |
| --- | --- |
| 0 | clean (with `--strict`: no warnings either) |
| 1 | problems (warnings or not) |
| 2 | the folder, `--schema` or `--ledger` cannot be read |
| 3 | `--strict` only: warnings and no problems |

`--json` prints the same findings as one JSON object on stdout, and
nothing else (stderr stays empty unless the folder cannot be read),
with the same exit status, `--strict` respected:

```json
{
  "problems": [],
  "warnings": {
    "unreachable": [], "audio": [], "voice": [], "character": [],
    "textTag": [],
    "translation": [
      "warning: lang/de.json: items.floor-2: no translation (base: 'Short line two.')"
    ],
    "poster": []
  },
  "coverage": {
    "de": {"strings": 44, "translated": 43, "missing": 1, "stale": 1,
           "unchecked": 0, "long": 0, "percent": 97.7}
  },
  "exitStatus": 0
}
```

`problems` holds the problem lines; `warnings` every kind, in the order
a plain run prints them, each a list of its lines (empty when none;
`poster` needs `--ledger`); `coverage` each listed language's counts,
`{}` for a game without translations; `exitStatus` what the run
returns.

The validator also warns about items no reading reaches. It replays the
player's own flow with Play all routes on, which shows every item any
reader's choices can show, and prints one line per item that flow never
shows, then a count, on stderr with the exit status left alone. An item
between a decision's last route and its `continueAt`, in none of its
routes, is the common case:

```text
warning: manifest.json: items[30]: item 'aside-unreached' is never shown: inside decision 'outer' (after 'branch-decide', before 'after-start') in none of its routes
my-novel: 1 unreachable item warning
```

Only a bookmark or `u` could land on such an item. Put it in a route or
on the main line, or remove it. These are the items a `--steps all`
walk from the opening reports as never shown, exit 3 (The quick check),
found without opening a browser; docs/content-format.md, "Rules and
validator invariants", lists every case.

## Playing the folder

`kinetic assemble` makes a playable copy of a content folder in one
command:

```sh
kinetic assemble my-novel novel-play
```

It copies the player bundle and the content, generates a missing
`manifest.js` and the missing script of each sound file (Sound, above),
ships the scripts without the sound files, carries the language files
under `lang/` (Translating a game) with a missing `lang/<tag>.js`
generated, leaves out the schema copies, `manifest.schema.json`
(Manifest) and `lang.schema.json`, which only your editor needs, and
prints the folder size (docs/packaging.md). With `--mac` and `--windows`
it adds the apps too (Building the apps).

In a checkout the bundle comes from `player/dist/`: run `npm run build`
in `player/` first if it is not current. There you may also copy the
bundle into the content folder by hand, which plays as well:

```sh
cp player/dist/index.html player/dist/app.js my-novel/
```

Double-click `index.html` to open the novel in your default browser.
The first keypress or click other than Esc puts the player in
fullscreen, so that first keypress can simply be space, the advance key.
It also starts a game's sound: in a browser the player plays none before
the first key or click other than Esc or a ⌘, Ctrl or Alt shortcut,
whatever the browser would allow, so after each load or reload a game
with sound shows "Press any key for sound" until then. The Mac and
Windows apps play sound from launch (Building the apps). A reader who
leaves fullscreen goes back on their next key or click, unless they
choose Window on the Esc screen (kept with the other settings).

Every key, screen and setting is described in docs/player.md.

To look at one item without reading up to it, add `#start=<id>` to the
page's address, such as `index.html#start=route1-start` for the demo's
first Route 1 line. The game opens at that item for that load, entering
the routes around it as `u` does, so Space reads on inside the route.
This counts as reading there: the item is marked seen, its routes
played, and the saved place moves to it. The player then removes
`#start=` from the address, so a reload resumes the saved place as usual
instead of jumping again. An id the game does not have opens the game
as usual, with one console warning naming it. The player reads the
address only as the page loads: typed onto a page that is already open,
`#start=` needs a reload to take effect.

In auto mode (`a`) the player advances at the configured auto-forward
speed ("Auto-forward speed" in the Esc screen's settings):
images hold for their text, animations complete their loops, and videos
play through once. A media item followed by `text` items holds for its
text alone while its animation or video loops underneath, and each
`text` item holds for the length of its text.

The folder can also hold a macOS app and a Windows program that readers
open instead of `index.html` (Building the apps, below). A game with
character voices speaks its lines in the Mac app and the Windows program
(Giving characters voices, below).

### Serving from a web host

The folder is static files, so any static web host serves it as it is:
upload the folder and readers open its `index.html` address in a
browser. Kinetic's own demo plays this way, on GitHub Pages. Nothing in
a game changes for this, and Kinetic designs for no host's rules. The
browser keeps a reader's progress per site, so what they read from disk
does not carry over to the web copy, or back; Export and Import on the
Esc screen move it. check-game's `--http` and the testing library's
`http` option play a folder this way on your own machine, and its
`--url` walks the uploaded copy (Testing your game).

## Giving characters voices

A game can speak its lines. Each character gets a voice, and the reader's
computer (a Mac or a Windows PC) generates every line in that voice while they
read, a few lines ahead of the one on screen. The voices belong to the game
folder; the speech model does not. It stays on the reader's machine, in a folder
the Kinetic app fills the first time the reader asks for spoken lines. A game
with no voices plays and validates as before.

What the reader sees, in the Mac app and the Windows program:

- The Esc screen's **Volumes...** sheet has a **Voice** row for a game that has
  recorded voice lines or lines the model would speak. Where lines need the
  model, the sheet shows **Download voice model** with its size (about 3.3 GB on
  a Mac, 6.8 GB on Windows), in place of the Voice slider, followed by a small
  **?** that explains the download on hover or keyboard focus. While it
  downloads the sheet shows progress with a Cancel button, and an error with a
  Retry button. Once the model is installed the Voice slider takes its place,
  with a small **Remove voice model** beside the label; Remove frees the space
  and asks first.
- There is no on/off switch for spoken lines. The Voice volume controls
  them: at 0 no line is generated, and raised again the line on screen is
  asked for again. Each line plays through the Voice volume,
  auto-forward waits for it to end, and a recorded voice line (an item's
  `audio.voice`) is always played instead of a generated one.
- The sheet and the **Sound** row show only what the game has: Music for a
  game with music or ambience, Effects for one with sound effects or video
  sound, Voice for recorded voice lines or lines the model would speak. A
  game with none of them has no Volumes... button, no Sound row and no
  `v` key. A game whose every line is recorded offers no download, in the
  app or in a browser tab: the Voice slider shows at once.
- In a game with translations these follow the language on show, and
  change as the reader switches: a language whose lines are recorded
  brings the Voice row (and, in a game with no other sound, the Sound row,
  Volumes... and `v`); a language with no sound at all takes them away;
  the download is offered only while the language on show has lines the
  model would speak (docs/content-format.md, "Translations").
- The download needs a Mac with Apple silicon and macOS 14 or later. On
  an older Mac, or an Intel one, the download button is greyed out and its
  ? says why.
- On Windows the download needs a PC with an NVIDIA card (driver 570.65
  or later); on any other PC the download button is greyed out and its ?
  says why.
- In a browser, a game with voices but no recorded lines plays silently.

The model installs once per computer, in
`~/Library/Application Support/Kinetic/Voice/` on a Mac and
`%LOCALAPPDATA%\Kinetic\Voice\` on Windows, and every Kinetic game on
the machine shares it (apps/README.md, "Spoken lines").

### The manifest

Two optional top-level fields describe the voices (docs/content-format.md,
"Voices"):

```json
"voices": {
  "Mei": { "file": "voices/mei.flac",
           "text": "Hello there. I've been waiting a long time...",
           "description": "A bright, quick young woman, warm and wry." }
},
"narrator": { "file": "voices/narrator.flac" }
```

- `voices` maps a speaker name, written exactly as the items' `speaker`
  gives it, to a reference clip: about 10 to 13 seconds of one person's
  clean speech, which the voice is cloned from. A speaker with no voice
  stays silent.
- `narrator` is one more voice, for the lines that have text and no
  speaker. Thoughts are spoken in their speaker's voice.

Each clip needs its `.js` script beside it, as a track does. The validator
checks the paths and warns about a voice no item uses.
`kinetic assemble` leaves the clips out of the folder it
assembles, ships their scripts, and writes any that are missing
(docs/packaging.md).

You rarely write these fields by hand: the casting tool writes them.

### Casting with the tool

`tools/cast_voices.py` makes the clips from descriptions. It needs a
checkout of Kinetic (In a checkout, above), a Mac with Apple silicon,
and its own packages in a separate virtualenv, since the voice model's
libraries do not belong in the converter's. From the repo root, once:

```sh
python3 -m venv .venv-voice
.venv-voice/bin/pip install --no-deps --only-binary :all: \
    -r requirements-voice.txt --cache .tmp/pip-cache
```

`pick` and `record` encode FLAC with the pinned ffmpeg, so they also need
the media tools (`.venv/bin/kinetic setup`; In a checkout, above).

Write a JSON file naming each speaker, exactly as the items do, with a
sentence describing the voice. The reserved key `"narrator"` is the
narrator's voice:

```json
{
  "Mei": "A bright, quick young woman in her twenties, warm and wry.",
  "Old Theo": "An old man with a slow, gravelly voice.",
  "narrator": "A calm, clear storyteller in middle age."
}
```

Then design the voices. The command starts itself again in `.venv-voice`,
and the first run downloads the design model, about 4.5 GB, into the
Hugging Face cache:

```sh
.venv/bin/python tools/cast_voices.py design my-novel descriptions.json
```

It makes four takes of each voice (`--takes N` changes the number), each
from its own random seed, in `my-novel-casting/` beside the game folder,
never inside it. A description narrows a voice without fixing it, so the
four takes are four different people. Open `my-novel-casting/index.html`
and listen: every take is there with its description and the `pick`
argument that chooses it. Run `design` again with `--takes 6` to add
takes, or with `--again` (and `--speakers "Old Theo"` to limit it) to
remake some with new seeds.

Pick one take per voice. `pick` copies it into the game as FLAC with its
script and writes the voice into `manifest.json`, keeping every other
byte of the file, then runs the validator:

```sh
.venv/bin/python tools/cast_voices.py pick my-novel Mei=2 "Old Theo=1" narrator=3
```

To use your own recording instead, name the clip and write out what it
says:

```sh
.venv/bin/python tools/cast_voices.py record my-novel Mei=mei-take.wav \
    --text "The tide is coming in early tonight, I can hear it."
```

`record` takes any format ffmpeg reads and warns about a clip shorter
than 5 or longer than 20 seconds; 10 to 13 is best. A game that really has
a character named "narrator" gives the tool another key with
`--narrator-key`. `.venv/bin/python tools/cast_voices.py --help`, and
`--help` on each command, list every option.

### Recording the lines

By default each reader's machine makes the lines, after a download of
about 3.3 GB on a Mac and 6.8 GB on a Windows PC with an NVIDIA card (a
Windows PC without one, or with a driver older than 570.65, is offered no
download: the button is greyed out and its ? says why). `tools/record_lines.py`
makes them once, here, and ships them in the game as recorded voice
lines. A reader of a game with every line recorded needs no model and
sees no download: the Voice volume is there at once, in a browser tab too.
Record when the game's readers should not have to download anything, or
when they use a browser. Leave the lines live when the game is small and
its readers have the apps: a recorded game is bigger, and its lines
sound as they did on the day you recorded them.

The tool speaks every line the player would speak live (an item with
text whose speaker has a voice, or no speaker when there is a
narrator, thoughts included) with the same engine the apps run, so a
recorded line sounds as the live one would. It skips an item that
already has its own `audio.voice`, so your own recordings stay. It
speaks the game's own language, the manifest's `language` (English when
it has none), as the apps speak it live; a game in a language the engine
does not speak (docs/content-format.md, "Spoken lines per language",
lists those it does) is refused before anything is touched. Quit
any Kinetic game app first, since it shares the voice folder. From the
root of a checkout (the wheel does not carry the tool), after the media
tools are set up:

```sh
.venv/bin/python tools/record_lines.py my-novel --dry-run
.venv/bin/python tools/record_lines.py my-novel
```

`--dry-run` says how many lines would be recorded, and about how long and
how large that is, without starting the engine. The real run uses this
machine's voice folder (`~/Library/Application Support/Kinetic/Voice/`
on a Mac, `%LOCALAPPDATA%\Kinetic\Voice\` on Windows), installing the
voice engine there first, with the same download the apps make, when it
is not complete. `--voice-dir DIR` uses another folder.

Each distinct line becomes one mono Opus file in WebM under
`my-novel/lines/`, with its script beside it, as a track in
`audio.tracks` named `rec-` and a code, and the item's `audio.voice`
names it. Two items that say the same words in the same voice share a
file. `--bitrate KBPS` sets the quality: 16 (the default) sounds good
and takes about 8 MB per hour of speech, 12 is usable. Progress goes to
the terminal every 10 seconds with the time left, and the end says how
many lines were recorded, reused and removed, and how big they are.

Expect lines to take a little over half their length on an Apple silicon
Mac, a third on a fast NVIDIA card. A large game of 75 hours of speech
takes about 40 hours on a Mac and adds about 0.8 GB (docs/voice-reading.md,
"A large game").
Nothing is lost if you stop it: press Ctrl-C, or let it die, and run the
same command again. It keeps every file it finished and carries on. A
run keeps the manifest saved to within a minute.

Each line says its text as shown, its text tags read
(docs/content-format.md, "Text tags"), as the apps speak it live. A
game recorded with an older Kinetic, whose lines said their tags, plays
as it did; run the tool again and it records only the lines with tags.

After you edit the game, run it again. It records only the lines whose
words or voice changed, points the items at them, and deletes the
tracks and files it made that no item uses any more. It never touches a
track it did not make. Casting a voice again (a new clip or a new
transcript) makes new recordings of that voice's lines at the next run.
The tool keeps `manifest.json` in its own indentation, rewrites
`manifest.js` if there is one, and runs the validator at the end.
Assemble the folder as usual: the `lines/` files stay out of it and
their scripts go in.

A game with language files (docs/content-format.md, "Translations")
can have each language's lines recorded too. `--lang TAG` records one language into its language file:

```sh
.venv/bin/python tools/record_lines.py my-novel --lang de --dry-run
.venv/bin/python tools/record_lines.py my-novel --lang de
```

It speaks the German text of every item `lang/de.json` translates whose
speaker has a voice (or the narrator, for a line with no speaker),
skipping an item the file already gives a recording of your own and,
when the file says `keepOriginalVoice`, an item whose base recording
plays under the German. The engine speaks German for it, as it would
live with German shown. The files go under `my-novel/lang/de/lines/`,
the tracks into the file's `voice.tracks` and the items into its
`voice.items`, and the tool rewrites `lang/de.json` and `lang/de.js`;
the manifest is not touched. Reruns, Ctrl-C and cleanup work as above,
within that language. The engine speaks 23 languages (Arabic, Chinese,
Danish, Dutch, English, Finnish, French, German, Greek, Hebrew, Hindi,
Italian, Japanese, Korean, Malay, Norwegian, Polish, Portuguese,
Russian, Spanish, Swahili, Swedish and Turkish); the tool refuses
another. A language it lacks stays silent in play unless you record
the lines yourself into the language file (docs/content-format.md,
"Translations").

### Hearing it

Assemble the folder and add the Mac app or the Windows program as usual
(Building the apps, below), open the app, press Esc and open Volumes...: the
Voice row offers the download. `fixtures/voice-demo`, built by `.venv/bin/python
fixtures/build_voice_demo.py`, is a small worked game with two characters and a
narrator whose clips came from this tool.

## Translating a game

A game can be read in more than one language from one folder. The
manifest stays in the game's own language, the base, and each
translation is a language file, `lang/<tag>.json` with its
`lang/<tag>.js`, holding that language's lines, speaker names, choice
questions and route labels, title and version (docs/content-format.md,
"Translations"). A game converted from Ren'Py brings the translations
its project has; any game can gain more later, from you or from
contributors, with the translator tools.

### What readers see

- **The Language control.** With more than one language, the Esc
  screen's title bar has a capsule at the right of "Esc or Space
  closes": a globe and the current language, named in itself
  (Deutsch, 日本語). A click opens a list of the game's languages over
  the screen, so nothing moves; the arrow keys move in it, and Enter or
  a click picks. Escape closes the list first, then the screen.
  A game with one language has no control, and the screen looks as it
  did.
- **The starting language** is the reader's system language when the
  game has it, matched loosely (`de-AT` takes `de`, `zh-TW` takes
  `zh-Hant`, `es-MX` takes `es-419`), otherwise the base. Once a reader
  picks a language, that pick wins, kept with their settings for this
  game.
- **A language for the Mac app alone.** A reader can give the game's
  Mac app a language of its own without changing the Mac's: System
  Settings, General, Language & Region, Applications, the + button, the
  app, then the language. From its next launch the app treats that
  language as the system language: the game starts in it when it has
  it, and the player's words and the app's menus use it. The list
  offers all 39 languages of the player's words, not only the game's
  own, so a reader can have the controls in a language the story lacks
  (the story then shows the base). A pick on the Esc screen still wins
  for the story, and the controls stay in the app's language. Windows
  has no per-program language setting for desktop programs like the
  exe, so readers there pick the story's language on the Esc screen and
  get the controls in Windows' own.
- **Switching keeps everything.** One item has one text in every
  language, so the place, picks, seen items, bookmarks and auto-forward
  stay as they were; the screen on show is drawn again in the new
  language. Auto-forward gives each language its own reading time:
  Chinese, Japanese and Korean, which say more per character, hold each
  character longer.
- **A missing line shows the original.** Each line, name, question and
  label falls back to the base on its own, so a part-translated game
  plays whole. A line whose original changed after it was translated
  still shows its translation until someone updates it.
- **The player's own words** (the Esc screen, help, pills, confirmation
  boxes, choice hints, the end card, the branch map, the Volumes sheet)
  come in 39 languages, and the Mac app's menus and the apps' first
  messages with them. They follow the system language (or the app's,
  or the browser's) when Kinetic has its words, otherwise English. The
  Language control changes the story only, never the controls: a reader
  who picks the game's original English under a Chinese system keeps
  Chinese controls. So a reader whose game has one language still gets
  the controls in their own. No manifest setting pins the controls to
  the game's language, by design: a reader changes them where they
  change every program's language. On a Mac that is System Settings,
  General, Language & Region, for the whole Mac or for the game's app
  alone (above); on Windows, the Windows display language, since the
  exe has no setting of its own; in a browser, the browser's preferred
  languages (docs/player.md, "Languages").
- **Checks that read the player's words** follow the language of the
  machine they run on unless they pin it. A script that reads the
  controls passes `language` to `openGame` (or `--lang` to `kinetic
  check`), which opens the game as for a reader whose system language
  that is, so the controls are in that language (or English, when
  Kinetic lacks it) on any machine (Testing your game).
- **Right to left.** Under an Arabic, Persian, Hebrew or Urdu system
  language the screens mirror: the text, choices, Esc screen, help, end
  card and pills read from the right, and sliders run from the right.
  A story picked in one of those languages under another system
  language reads right to left in its own lines, names, questions and
  labels, while the screens keep their layout. The branch map keeps
  its layout (its labels still read right to left), and the arrow keys
  keep their direction on the keyboard.
- **Spoken lines follow the language shown** (Giving characters
  voices). A language file may carry its own recorded lines; without
  one for a line, the apps speak it live in that language, and a
  browser, or a language the voice engine does not speak, stays silent.
  A language file with `"keepOriginalVoice": true` plays the original
  recording of a line it has not recorded itself under its text, like
  subtitles, rather than speaking it live; without it the original
  recordings stay silent under a translation.

### The author's flow

Translators work in PO files (gettext), which every translation tool
reads. `tools/translations.py` writes one per language from the game,
and turns the translated file back into the game's language file
(docs/translating.md is its reference). It needs a checkout (the
wheel does not carry it); from the repo root, with the game's content
folder `my-novel`:

```sh
.venv/bin/python tools/translations.py export my-novel de
```

This writes `<storyId>.de.po` in the current folder, `my-novel.de.po`
for a game whose `storyId` is `my-novel` (`--out FILE` names another
file): one entry per line, speaker name, question, route label, title
and version, in story order, each with notes on who speaks, the lines
around it and its length. Send it to the translator. When it comes back:

```sh
.venv/bin/python tools/translations.py import my-novel my-novel.de.po
.venv/bin/python tools/translations.py status my-novel
```

`import` writes `lang/de.json` and `lang/de.js`, adds `de` to the
manifest's `languages` and rewrites `manifest.js`, then prints what the
validator says of German. It refuses a file made for another game, and
one in the game's own language. `status` prints each language's
coverage:

```text
my-novel: base language en, 39 strings to translate
de: 38 of 39 strings (97.4%), 1 stale, 0 unchecked, 1 missing
```

The validator (Validating) checks every language on each run: a
warning for each missing string, each stale one (translated from an
earlier wording of its original) and each translation much longer than
its original. These are warnings, not problems: the game plays, showing
the original where a line is missing, and the validator exits 0 unless
`--strict` is given (exit 3). A complete translation prints nothing;
`status`, `kinetic report` and `kinetic validate --json` give each
language's coverage.
A translated question must stay under 200 characters and a label under
120, as in the base; those are problems.

After you edit the story, export the language again. The new file
keeps every translation, adds empty entries for new lines and marks a
line whose original changed as needing review (fuzzy), so the
translator sees what to check. Importing that file keeps a reviewed
line current and leaves one still marked as stale.

Walk the game in each language before release (Testing your game,
"Checking a translation"):

```sh
kinetic check novel-play --lang de --steps all
```

It reports the lines the walk met that showed the original or were
stale. Assembling (Playing the folder) carries `lang/` into the folder
readers get, and `kinetic upgrade` leaves it as it is.

### A contributor's flow

A contributor needs only the PO file the author exported and a
translation tool:

- **Poedit**, a free desktop editor for macOS, Windows and Linux: open
  the file, type each translation, save, send the file back.
- **Weblate** or **Crowdin**, online, where several people translate one
  game in the browser; both host open-source projects free. Add the
  exported file to the project as that language's translation file,
  then download it translated for the author to import.

In the file, each entry is an original (`msgid`) and its translation
(`msgstr`):

```text
#. Speaker: Mei
#. Item: text-thought, a text item; a thought, not said aloud
#. Before: text-speech: Spoken dialogue: the speaker's name, Mei, sits above it.
#. After: text-narration: Narration has no name. Press h to hide all text; press h ag…
#. Base length: 60 characters.
#, fuzzy
msgctxt "item:text-thought"
msgid "A thought: unspoken, so it is drawn differently from speech."
msgstr "Ein Gedanke: unausgesprochen, darum anders dargestellt."
```

- Fill in `msgstr` only. `msgctxt` says which line it is (`item:` and
  the item's id, `speaker:`, `prompt:`, `label:`, `title`, `version`):
  leave it, and the `msgid`, exactly as they are. Tools show `msgctxt`
  as the context and keep it.
- The `#.` lines are notes: who speaks, whether it is a thought, the
  two lines before and after, the decision or route, and the original's
  length. Poedit shows them as notes for translators; Weblate and
  Crowdin show them beside the string. Keep a line about as long as its
  original: the validator warns about one over one and a half times its
  length, and a question or label has a hard limit.
- Keep line breaks where the original has them. The player shows a line
  exactly as written, markup included: a converted game's line may hold
  a Ren'Py leftover such as `[name]`, which readers see as it stands, so
  copy it into the translation unchanged.
- Leave `msgstr` empty for a line you have not translated: readers see
  the original there. A speaker's name may stay the same as the
  original; fill it in anyway, so the tools count it as done.
- An entry marked fuzzy (`#, fuzzy`, as above; Poedit's "Needs work",
  Weblate's "Needs editing") is one whose original changed since it was
  translated. Check it, fix it if needed, and clear the mark.

### Ren'Py games

`kinetic extract` reads a Ren'Py project's own translations from
`game/tl/<language>/`, loose or inside its archives, and writes a
language file per language, its lines matched to the story by Ren'Py's
own translation identifiers (Converting, checking and playing one game;
docs/extracting.md, "Translations"). The summary prints each language's
coverage. Three options change it:

- `--language-map NAME=TAG` gives the language tag of a `tl/` folder
  the converter does not know (`--language-map klingon=tlh`;
  repeatable).
- `--base-language TAG` names the game's own language when it is not
  English (`--base-language ja`), so its `tl/english` becomes an English
  language file.
- `--no-translations` converts the base language alone.

A game with recorded voice lines gets `"keepOriginalVoice": true` in
each language file, as Ren'Py plays the original voices under a
translation. Ren'Py's per-language fonts and replacement files are left
out. `status` then shows what the converted languages cover, and
`export` hands the rest to a translator.

### Spoken lines per language

`tools/record_lines.py --lang TAG` records one language's lines into its
language file, under `lang/<tag>/lines/`, as it records the base's
(Recording the lines):

```sh
.venv/bin/python tools/record_lines.py my-novel --lang de
```

Assembling ships each recorded line's script and leaves the audio file
out, as it does for every track.

### Correcting the player's own words

The player's words in each language are a PO file in this repo,
`player/locales/<tag>.po`. The 38 besides English are drafts no native
speaker has reviewed yet, and corrections are welcome: edit a
`msgstr`, keeping every `{placeholder}` as it is (the player fills in a
key or a number there), then run `npm run i18n` and `npm test` in
`player/`, and check that the longer wording still fits
(docs/verify-player.md, "The player's words", says how, and how to add
a language).

### What is not translated

- **Pictures** are the same in every language: text drawn into a
  picture or video stays as drawn. Put words a reader must read into the
  lines rather than the pictures.
- **Fonts**: the player draws every language with the reader's system
  fonts, a readable face per writing system, so Chinese, Japanese and
  Korean each get their own forms of the characters they share. A
  language file can neither name nor ship a font, by design.
- Whether a line is a thought, media, timing, sound other than voice
  lines, branches and ids are the manifest's, the same in every
  language.

The format of the language files is in docs/content-format.md,
"Translations"; the translator tools' reference is
docs/translating.md.

## Building the apps

A game folder can also hold a macOS app, `<title>.app`, and a Windows
program, `<title>.exe`. A reader double-clicks one instead of
`index.html`. The Mac app shows the game through the Mac's own WebKit
(the engine Safari uses) with the game's name and Dock icon. The Windows
program shows it in a window of its own through WebView2, the Microsoft
Edge engine built into Windows. Both start fullscreen, reopen the way the
reader left them, and leave Esc to the game. Each holds only a small program. It plays the `index.html`,
`app.js` and media beside it, so nothing is copied into it and no macOS
check reads the media.
`index.html` keeps working everywhere and stays the route for every
other reader.

Add the apps to an assembled folder, or assemble with them:

```sh
kinetic apps novel-play --mac --windows
kinetic assemble my-novel novel-play --windows --icon cover.png
```

In a checkout `.venv/bin/kinetic` does the same. Each app is a copy
of a small host program that every Kinetic release builds once and
carries; `kinetic apps` writes the game's title, storyId, first window
size and icon into the copy, and the app reads them as it starts.

- `--mac` adds `<title>.app`, named from the manifest `title`, with `/`
  and `:` written as `-` (the folder's name when there is no title). The
  manifest needs a `storyId` (Manifest, above), since the app keeps
  readers' progress under its bundle id, `org.kinetic.game.<storyId>`
  (`_` written as `-`). `kinetic apps` refuses a manifest without one.
  It also writes the pixel size of the game's first graphic (see
  `--icon`) into the app, for its first window, and prints it; a game
  with no readable picture gets a 16:9 first window.
- `--windows` adds `<title>.exe`, named the same way, with the other
  characters Windows refuses in a file name (`\ * ? " < > |`) also
  written as `-`. It keeps readers' progress under the `storyId` too, so
  it needs one as well. It gets the same first-window size as the Mac
  app, and prints it.
- Running it again replaces the app or exe it made before, and a
  failure leaves the folder as it was. After a title change it names
  the app or exe left under the old title; delete it yourself.
- `--icon IMAGE` names the icon picture for both: a PNG, JPEG, WebP, GIF
  or JPEG XL file, cut to the largest square in its middle. Without it
  the icon is the game's first graphic: the first item with a picture,
  which is an image, an animation's first frame or a video's poster. A
  picture that cannot be read stops it and names the file.
- With neither `--mac` nor `--windows`, `kinetic apps` prints its usage
  and makes nothing. Asked for both, it checks everything both need
  before it makes either. `kinetic assemble` checks the `storyId`,
  macOS for the Mac app and the icon before it copies anything.

Both apps speak the reader's language where they draw words of their
own: the Mac app's menus (Hide, Quit, View, Reload, Toggle Full Screen)
and its alert when it cannot find its game, and the Windows program's
error box, in any language of the player's own catalogue, else English.
Before the game opens they follow the system's language; once it runs
they follow the language the player's words are in, and the window takes
the game's title in the language shown. In a checkout where the player's
catalogue has changed since `npm run i18n` last ran, the build stops and
says to run it.

Making the apps needs no Swift or Go. The Mac app needs a Mac, which
signs it with its own `codesign`; on any other system `--mac` stops with
one error saying so and writes nothing. No Apple ID or certificate is
needed, since the app is signed ad hoc. The Windows program is made on
macOS, Linux or Windows alike: its icon, version details and settings
are written into the copy's resources directly.

Only a checkout builds the hosts themselves, once, the first time they
are needed, into `.tmp/app-hosts/` (again only after their sources
change): the Mac host needs Xcode or the Command Line Tools
(`xcode-select --install`), and the Windows host Go 1.27 or later
(https://go.dev/dl/) on any system, downloading nothing and keeping Go's
caches in `.tmp/windows-app-build/`. Without them `--mac` or `--windows`
stops with one error saying so, and says a release wheel carries the
host prebuilt.

What Mac readers get and see:

- They double-click `<title>.app` in the game folder, and the game opens
  fullscreen the first time. Exit on the Esc screen quits, as do ⌘Q and
  closing the window. ⌘R reloads. Export on the Esc screen saves to
  Downloads, and Import opens a file panel.
- The Esc screen's Fullscreen | Window switch, the green button and
  ⌃⌘F all switch between fullscreen and a window, and the switch shows
  whichever is in force. No other key leaves fullscreen or beeps:
  holding Esc only opens the Esc screen. The app reopens the way it was
  left, so a reader who chose a window gets a window, with no fullscreen
  first.
- The first window takes the size and shape of the game's first graphic,
  scaled down to fit the screen and centred. After that the app keeps
  the size and place the reader gives the window.
- A game with sound plays it from launch, with no key or click first and
  no "Press any key for sound" hint.
- Progress is kept per app, under its bundle id (so remaking it keeps it)
  and apart from any browser's. A reader who played `index.html` in a
  browser starts over in the app, or moves the progress across with
  Export and Import.
- The first time the app opens from Documents, Desktop or Downloads,
  macOS asks once whether it may use that folder. A remade app may ask
  again, since its ad-hoc signature changes with what it holds.
- A folder downloaded as a zip carries macOS's quarantine flag, and the
  app will not open there: macOS refuses it, or runs it away from its
  folder, where it finds no game and says so. Readers of a download open
  `index.html` instead, or clear the flag first with
  `xattr -dr com.apple.quarantine <folder>`. A folder you build or copy
  on your own Mac has no flag, so its app opens with no check.
- The app reads only files inside the game folder. A symbolic link in
  the folder that points outside it (media linked from another disk,
  say) loads nothing in the app, though Chrome follows it; copy or
  hard-link those files into the folder instead. The testing library
  names such links when it opens the folder, and check-game fails on
  them on both engines (Testing your game).
- The app runs on Apple silicon Macs with macOS 12 or later. Intel Macs
  use `index.html`.

What Windows readers get and see:

- They double-click `<title>.exe` in the game folder, and the game opens
  fullscreen the first time, in a window of its own. Every key belongs to
  the game: holding Esc only opens the Esc screen. Exit on the Esc screen
  closes the game, as does closing the window. F5 and Ctrl+R reload.
- The Esc screen's Fullscreen | Window switch and F11 both switch between
  fullscreen and a window, and the switch shows whichever is in force.
  Fullscreen covers the whole screen and shows no notice. The exe reopens
  the game the way it was left, so a reader who chose a window gets a
  window, with no fullscreen first.
- The first window takes the size and shape of the game's first graphic,
  scaled down to fit the screen and centred. After that the exe keeps the
  size and place the reader gives the window, on that screen while it is
  connected. It stays sharp on high-resolution screens.
- Export on the Esc screen saves into Downloads, never over a file there
  (a second export becomes `<storyId>-progress (2).json`), and the
  screen's pill says "Progress exported", naming no file. Import opens
  Windows' file dialog.
- Double-clicking the exe while the game is open brings its window to the
  front.
- The exe asks WebView2 to play a game's sound from launch, as the Mac app
  does (apps/README.md, "Sound at launch"). This is not yet checked on
  Windows; if WebView2 refuses, the reader's first key starts the sound,
  as in a browser.
- Progress is kept in a folder only this game uses,
  `%LOCALAPPDATA%\Kinetic\WebView2\<storyId>`, apart from the reader's
  browsers and any browser that played `index.html` (Export and Import
  move progress across). Remaking the exe keeps it. The window's mode
  and place are kept in that folder too (`kinetic-window.json`), with a
  log of the exe's last run (`kinetic-host.log`) to ask for when a reader
  reports a problem.
- The exe needs the Microsoft Edge WebView2 Runtime. Microsoft says the
  runtime is preinstalled on all Windows 11 devices and that it installed
  the runtime on all eligible Windows 10 devices, though a small number
  of Windows 10 devices do not have it (Microsoft's WebView2 docs:
  [Evergreen vs. fixed version](https://learn.microsoft.com/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version#windows-11-devices-and-windows-10-devices),
  [Distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution#windows-11-devices-and-windows-10-devices-details)).
  Where it is missing the exe opens `index.html` in the default browser.
- The exe runs on 64-bit Windows 10 and 11 on Intel and AMD processors.
  Windows 11 on Arm runs it through its x64 emulation. Windows 10 on Arm
  cannot run it, so readers there use `index.html`.
- The exe is not signed. A zip downloaded from the internet carries
  Windows's Mark of the Web, and Windows's own Extract All passes it to
  the exe. Its first run then stops at SmartScreen's "Windows protected
  your PC": the reader chooses More info, then Run anyway. To skip that,
  readers can unblock the zip before extracting it (right-click it,
  Properties, tick Unblock). With Smart App Control on (Windows 11),
  Windows may block an unsigned download outright; those readers open
  `index.html`. A folder you build or copy on your own PC carries no
  mark, so its exe starts with no prompt.

Keep each app inside its game folder. Upgrading the player
(`kinetic upgrade`, Upgrading to a newer Kinetic) needs no new apps,
since each app plays whichever `index.html` sits beside it.

Each app answers `--self-check FILE` by writing the settings it reads to
FILE as JSON and exiting, with no window: run
`"<title>.app/Contents/MacOS/kinetic" --self-check out.json` on a Mac, or
`"<title>.exe" --self-check out.json` on Windows, to see the title,
storyId, first window size and Kinetic version an app was made with
(apps/README.md, "Game settings").

Kinetic is under the MIT License (`LICENSE` in this repo), and the
notice travels in what you ship: the folder's `index.html` and `app.js`
open with it as a comment, the Mac app holds it in
`Contents/Resources/LICENSE`, and the Windows program in its resources.
You owe nothing beyond shipping the folder and apps as made: leave
those files as they are and the license is met.

## Testing your game

`kinetic check`, or a test script of your own, plays a built game folder
with no window on screen, to check after each change that the game still
plays as you expect. `kinetic check` runs check-game, the program this
section calls by that name (in a checkout, `node
player/scripts/testing/check-game.mjs` is the same). It opens the
folder's own `index.html` and `app.js`, so it tests exactly what readers
get. It presses the reader's keys and reads what the screen shows: the
manifest item, its line and speaker, and any open choice.

Two engines run it:

- `webkit` is the Mac's own WebKit, set up the way the macOS app sets
  up its web view. It stands for the macOS app and for Safari readers.
  It needs macOS and a small helper program: a release carries it
  prebuilt. In a checkout the first open builds it into the repo's
  `.tmp/`, which takes a few seconds and needs Xcode or the Command
  Line Tools (`xcode-select --install`).
- `chrome` is Google Chrome, headless. It stands for Chrome readers and
  for the Windows app, whose WebView2 is Microsoft Edge's engine
  (Chrome's).
  It needs Chrome installed. `KINETIC_CHROME=<program>` names another
  Chrome, Chromium or Edge.

`auto`, the default, takes WebKit on a Mac that has the helper or can
build it, otherwise Chrome, and prints which. Test on both before a
release.

Nothing appears on screen with either engine, and neither takes the
focus. Chrome runs headless. The WebKit helper is a background program
with no Dock icon whose one window sits off every screen; it quits
rather than show that window. `openGame` and check-game make no sound
either: the library tells the player to hold its output at zero on every
page, Chrome plays to no audio device and the WebKit helper mutes its
page, while the game's sound still plays and `current().audio` reports it.

### Setting up the tests

From a release, `kinetic check` and a test script of your own need only
Node.js 22.12 or later on your PATH, and Chrome for the `chrome` engine
(From a release, above). The release carries the testing library a
script imports, puppeteer-core inside, so there is nothing to install
with npm; `kinetic check --library` prints its path (A test script,
below). The library keeps the browser profiles it makes in Kinetic's
cache (docs/packaging.md, "Installing the tools").

In a checkout, `kinetic check --library` prints the path of
`player/scripts/testing/kinetic.mjs`. Once per checkout, install the
player's packages and build the player:

```sh
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
```

Tests open an assembled game folder (Playing the folder).

### The quick check

```sh
kinetic check novel-play --steps all
```

It opens the folder and presses Space, printing a line each time the
screen changes: the step, the item's id, the start of its line, and any
choice or screen open over it. At a choice, Space takes the highlighted
route, as it does for a reader with Play all routes on, so a walk to the
end plays every route. `--engine webkit` or `--engine chrome` picks the
engine. The other options:

- `--steps N` presses Space at most N times (10 without `--steps`).
  `--steps all` presses until the story ends, giving up after twice the
  manifest's item and segment count (every video item's `segments`,
  since each view takes a press) plus 1,000 presses.
- `--start-at ID` opens the game at item ID, as step 0, entering its
  routes as `u` does (the URL start, Playing the folder). A folder whose
  player is too old to start at an item opens, says so and exits 1;
  upgrade its player (Upgrading to a newer Kinetic):

  ```text
  openGame: the folder's player does not support starting at an item (asked for "route1-start", it opened at "intro-title"); rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")
  ```

- `--until ID` stops when item ID first shows. It walks as `--steps all`
  does unless `--steps` is given, and reports the span it walked
  (Checking part of a game, below).
- `--no-media-check` skips the media check after the walk (The media
  check, below).
- `--trace FILE` writes the player's record of every screen the walk
  showed to FILE, one JSON object per line (The item trace, below).
- `--lang TAG` walks with that game language shown, and reports the
  lines that fell back to the original or are out of date (Checking a
  translation, below).
- `--http` serves the folder over HTTP on 127.0.0.1, as a web host
  would, and walks it there instead of from disk (Serving from a web
  host). The first line ends `, over HTTP at <address>`.
- `--url URL` walks the copy of the folder already served at URL, such
  as the one you uploaded to a web host (`https://...`, ending in `/`).
  The manifest and the list of media files to check come from the folder
  on disk, the files themselves from URL.

Any walk stops at the story's end, whatever `--steps` says. The story
has ended when Space changes nothing (the same item, line, picture,
choice, screen and video view) while the player's end card shows, or on the
manifest's last item. Anywhere else, Space changing nothing five times
running over at least 2 s means the player is stuck: the walk stops and
names the screen.

After the walk it prints how the walk stopped: `story ended at step N`,
N being the step that first showed the last screen, or `stopped after N
steps`, followed by the reason when there is one (`reached ID
(--until)`, a stuck player, the `--steps all` limit). Then a summary:

- `visited X of Y items`: how many of the manifest's items the walk
  showed.
- For a folder with an older player, one that does not name the item on
  screen, how many steps the check named from the screen instead and
  how many of those were guesses between look-alike items. Upgrading
  the folder's player (Upgrading to a newer Kinetic) ends the guessing.
- After a walk from the opening (no `--start-at`) that reached the
  story's end, `never shown:` and up to ten ids of items it never
  showed, in manifest order.
- After a walk that reached its `--until` item, `span:` and the items of
  the span not shown (Checking part of a game, below).
- `line overflow at W x H: none`, or how many lines overflowed and up to
  ten of their ids (Lines that overflow, below).
- With `--trace FILE`, `trace: N records written to FILE, D dropped`.
- With `--lang`, the fallback and stale lines met (Checking a
  translation, below).
- `media: N files: L loaded during the walk, C checked after it (R never
  requested)`, from the media check.

Then it lists any console or page errors, among them each file that
failed to load or decode, and ends `N console or page error(s)`, or
`no console or page errors`.

During the walk a line on stderr every 30 s names the step, the items
seen so far and the screen, so a long walk shows it is still going:

```text
check-game: step 30; 28 items seen; on screen: nest-return "Nested 1b: when it ends, the nested decision is offered a..."
```

On the demo, `--steps all` starts:

```text
webkit: /Users/you/demo-play (Kinetic 1.8.0)
  0: intro-title "Kinetic demo. Every line explains what you are seeing. Sp..."
  1: text-speech "Spoken dialogue: the speaker's name, Mei, sits above it."
  2: text-thought "A thought: unspoken, so it is drawn differently from speech."
```

and ends, on WebKit and Chrome alike but for how the `media:` line
splits its 26 files (The media check, below):

```text
  33: route1-end "Route 1 again, after the nested decision. Its end leads t..."
  34: after-start "Shared aftermath: reached by finishing Route 1. Return to..."
  35: after-end "The end. Also try: u for unseen content, e for the end of..."
story ended at step 35
visited 32 of 32 items
line overflow at 960 x 540: none
media: 26 files: 1 loaded during the walk, 25 checked after it (3 never requested)
no console or page errors
```

The first line names the engine, the folder and the Kinetic version of
the folder's player, read from its `app.js`: a player built from a
checkout between releases says so (`Kinetic 1.9.0-dev`), and one built
before Kinetic 1.8.0, which did not record its version, gives `Kinetic
unknown`. `kinetic check --version` prints the version of your Kinetic
instead and opens nothing.

The exit status says how it went:

| Status | Meaning |
| --- | --- |
| 0 | Passed. |
| 1 | Console or page errors (a file that failed to load or decode, a symbolic link out of the folder), a game that would not open (a player too old for `--start-at` among them, or a game that opened in another language than `--lang` asked for), a stuck player, the `--steps all` limit, an `--until` item not reached, a media check that stalled or failed, or a `--trace` the folder's player cannot keep (an older player). |
| 2 | Bad arguments: an unknown option, an `--engine` other than `webkit`, `chrome` or `auto`, a `--steps` that is neither a number nor `all`, an id the manifest does not have, a `--trace` with no FILE or one that cannot be written, or a `--lang` the game does not offer (checked before anything opens). |
| 3 | A walk from the opening reached the story's end with items never shown, or a walk reached its `--until` item with items of its span not shown. |

1 wins over 3: a walk with errors and items never shown exits 1.

#### Lines that overflow

check-game opens the game in a window of the manifest's `width` x
`height`, as the macOS app first opens it, scaled with its shape kept
to fit within 1920 x 1200 or to reach 480 x 270 (1280 x 720 for a
manifest without a size). The first time each line shows, it measures
the line in the page. The text band sits at the bottom of the screen and
grows upward with its text, so a line too long for the screen runs off
its top, and a word too long to wrap (a long run with no spaces) runs out
of its column sideways. Each such line prints a warning below the step
that showed it, saying by how many pixels and where:

```text
  2: text-thought "A long line that will not fit. A long line that will not ..."
warning: text-thought: its line overflows at 960 x 540: 307 px above the screen
```

The summary says `line overflow at 960 x 540: none`, or how many lines
overflowed and up to ten of their ids. An overflowing line is a warning,
not a failure: the exit status does not change. Split the line into two
items, or shorten it. `kinetic report` lists the longest lines without
opening a browser (Checking a conversion: kinetic report, below).

#### Checking part of a game

To check content late in a long game without walking everything before
it, start at the first item of the scene, and stop where it ends or
after a number of steps (`--steps N`):

```sh
kinetic check demo-play --start-at route1-start --until after-start
```

```text
webkit: /Users/you/demo-play (Kinetic 1.8.0)
  0: route1-start "Route 1, first line. A nested decision opens after the ne..."
  1: route1-nest "Route 1, second line: the nested decision hangs off this ..."
  2: route1-nest "Route 1, second line: the nested decision hangs off this ..." with the choice "Nested decision inside Route 1:" open
  3: nest-return "Nested 1b: when it ends, the nested decision is offered a..."
  4: nest-return "Nested 1b: when it ends, the nested decision is offered a..." with the choice "Nested decision inside Route 1:" open
  5: nest-continue "Nested 1a: when it ends, Route 1 carries on."
  6: route1-end "Route 1 again, after the nested decision. Its end leads t..."
  7: after-start "Shared aftermath: reached by finishing Route 1. Return to..."
stopped after 7 steps: reached after-start (--until)
visited 6 of 32 items
span: 6 of 6 items shown from route1-start to after-start
line overflow at 960 x 540: none
media: 2 files: 0 loaded during the walk, 2 checked after it (0 never requested)
no console or page errors
```

Without `--steps`, `--until` walks as `--steps all` does, however far
its item is; `--steps N` still stops the walk after N steps. Reaching
its item, the walk reports the span from where it started (the opening,
or the `--start-at` item) to the `--until` item: `span: X of Y items
shown from START to UNTIL`. The span holds the items between the two in
manifest order, both included, leaving out the other routes of each
decision whose route holds the start. A reader who starts inside Route
1 need not play Route 2, so the span above has 6 items, not the 8 that
lie between in the manifest. From a start on the main line every item
between counts, every route of a decision included, since Play all
routes plays them all. When some were not shown, `not shown in the
span:` names up to ten in manifest order and the run exits 3. On a copy
of the demo with an item in no route after Route 2 (Items never shown,
below), on WebKit and Chrome alike:

```sh
kinetic check demo-gap --start-at branch-title --until after-start
```

```text
stopped after 14 steps: reached after-start (--until)
visited 11 of 33 items
span: 11 of 12 items shown from branch-title to after-start
not shown in the span: aside-unreached
line overflow at 960 x 540: none
media: 6 files: 0 loaded during the walk, 6 checked after it (0 never requested)
no console or page errors
```

An `--until` item before the start in manifest order is walked to all
the same, since a returning route can lead back there; reaching it, the
span line says `span: none: UNTIL comes before START in manifest order`.

A walk that ends without reaching its `--until` item (at the story's
end, or when the steps run out) says `never reached ID (--until)` and
exits 1. An id the game does not have exits 2 before anything opens:

```text
check-game: this game has no item "nowhere" (--start-at)
```

A walk from `--start-at` skips whatever came before it, so it names no
items never shown; only its `--until` span can make it exit 3.

#### Items never shown

To check that every item can be reached, run `--steps all` from the
opening: a new reader has Play all routes on, so the walk plays every
route. Exit 3 means it reached the end without showing some items, and
the summary names them. A copy of the demo with an extra item between
Route 2's end and the aftermath, in no route, ends:

```text
story ended at step 35
visited 32 of 33 items
never shown: aside-unreached
line overflow at 960 x 540: none
media: 26 files: 2 loaded during the walk, 24 checked after it (3 never requested)
no console or page errors
```

Play all routes never reaches such an item: put it in a route or on the
main line, or remove it. The validator accepts the folder (exit 0) but
warns about the same item without opening a browser (Validating).

#### The media check

A walk faster than a reader moves past pictures and videos before they
finish loading, and a load cut short reports no error. So after the
walk, before reading the errors, check-game checks every media file the
walk passed (`checkMedia()`, What the library offers): each file the
page was given but did not see load (every poster among them, since a
poster reports nothing when it fails), and each file a shown item
references that the page was never given, such as an animation's later
frames, which a fast walk never cycles to, and each sound track's
script. The files are loaded and decoded off screen, in parallel: on
Chrome in up to 4 pages of their own, each in its own browser context,
on WebKit 8 at a time in the game's page. A file that fails is listed
among the errors once, as the page would list it (Failed loads, below).

The summary's `media:` line counts those files once each:

- N, every file the walk passed: L plus C.
- L, the files whose load the page saw finish (or fail) during the walk.
- C, the files checked after the walk.
- R, those of the C files the player never asked for, such as the
  animation frames after the first.

On the demo, N is 26 and R is 3, the animation's three later frames;
how N splits between L and C depends on timing, and differs between
runs and engines.

When 100 or more files are left to check, a line on stderr says so
before the check starts, `check-game: checking N media files the walk
did not see load...`. That N is the summary's C, the files left to
check, not every file the walk passed. While the check runs, a line on
stderr every 30 s says how far it has got, `check-game: media check: C
of T files checked`.

`--no-media-check` skips the check, and the summary says `media files
not checked (--no-media-check)` in place of the `media:` line. The exit
status then comes from the walk and the console alone: a broken file
fails the run only if the page's own picture or video reported it
during the walk, and a fast walk cuts most loads short before they can
fail. Use it to time a walk, or to check the story's flow while the
media are still being made.

#### Failed loads

A file inside the folder that failed to load or decode is one line among
the errors, once per file, with the reason read from the disk, the same
on both engines: `not found`, `could not decode`, `not readable` (no
permission to read it) or `a symbolic link out of the folder` (below).
A copy of the demo with one picture deleted and junk in another and in
a video's poster lists, on WebKit and Chrome alike:

```text
  [error] Failed to load resource: file:///Users/you/demo-broken/chain-still.jpg (could not decode)
  [error] Failed to load resource: file:///Users/you/demo-broken/branch-title.jpg (not found)
  [error] Failed to load resource: file:///Users/you/demo-broken/video-hold.poster.jpg (could not decode)
3 console or page error(s)
```

and exits 1.

#### Symbolic links out of the folder

A symbolic link in the folder that points outside it fails the run on
both engines, exit 1. WebKit and the macOS app cannot read a file
through such a link, though Chrome can, so a game that passes on Chrome
would still miss those files there. The first error names up to three
links and says how many there are, and on WebKit each file that failed
to load through one adds its own line. A copy of the demo with one
picture moved out of the folder and linked back lists, on WebKit:

```text
  [error] 1 symbolic link in this folder points outside it (after-start.jpg). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.
  [error] Failed to load resource: file:///Users/you/demo-link/after-start.jpg (a symbolic link out of the folder)
2 console or page error(s)
```

Copy or hard-link the files into the folder. A link that stays inside
the folder is fine.

#### Video segments

A Space that steps a video's views (Camera views in one video:
segments) changes the screen, so check-game prints it as a step of its
own, its line ending `view n of m`, `n` counting from 1. A view step is
never a stuck player, and a video with views as the story's last item
ends the walk at its last view, not before. On a copy of the demo whose
`floor-clip` (6 s, two more lines after it) carries three views, 0 to
2 s, 2 to 4 s looping from 2.5 s, and 4 to 6 s:

```sh
kinetic check demo-segments --start-at floor-clip --steps 6
```

```text
webkit: /Users/you/demo-segments (Kinetic 1.8.0)
  0: floor-clip "Short line one."
  1: floor-2 "Short line two."
  2: floor-3 "Line three waits."
  3: floor-3 "Line three waits." view 2 of 3
  4: floor-3 "Line three waits." view 3 of 3
  5: branch-title "Next: a decision. Route 1 continues the story and holds a..."
  6: branch-lead "Shared lead-in: every route starts after this. The decisi..."
stopped after 6 steps
visited 5 of 32 items
line overflow at 960 x 540: none
media: 4 files: 1 loaded during the walk, 3 checked after it (0 never requested)
no console or page errors
```

The views step on the last line only. The walk reached it while the
video was still in its first view, so the first Space went to view 2,
the first one starting after that point, as a reader's would. A slower
walk, or a reader who lingers, can see fewer views: the steps start
from wherever the video has got to. The same copy's `--steps all` walk
prints these steps on WebKit and Chrome alike, and its cap counts each
view as a press.

In a script (A test script, below), `current().segment` is the view
showing, `{ index, count }` with `index` counting from 0, or `null` when
none is; `spaceUntil` counts a view step as a change. On the same copy:

```js
const game = await openGame(folder, { engine, startAt: "floor-clip" });

// The lines come first: no view is active on the way to the last one.
const last = await game.spaceUntil("floor-3");
assert.equal(last.segment, null);

// Space on the last line steps the views; step until the last one.
const end = await game.spaceUntil((now) => now.segment?.index === 2);
assert.deepEqual(end.segment, { index: 2, count: 3 });

// Left steps back a view and Right forward again, never leaving.
await game.press("ArrowLeft");
assert.deepEqual((await game.current()).segment, { index: 1, count: 3 });
await game.press("ArrowRight", { times: 2 });
assert.deepEqual((await game.current()).segment, { index: 2, count: 3 });

// Past the last view, Space leaves the item.
await game.press("Space");
assert.equal((await game.current()).id, "branch-title");
```

#### Checking a translation

`--lang TAG` walks a translated game (Translating a game) in one of its
languages: the manifest's own `language` or one its `languages` lists.
The game opens as it would for a reader whose system language that is,
so the player's own words follow it too where Kinetic has them in that
language (English otherwise). A tag the game does not offer exits 2
before anything opens, naming the languages it has.

```sh
kinetic check novel-play --lang de --steps all
```

The first line ends `, language de`, the steps show the lines as
German readers see them, and after the walk two lines count the lines
it met (the items it showed that have text):

```text
webkit: /Users/you/lang-demo-play (Kinetic 1.11.0), language de
  0: intro-title "Kinetic-Demo. Jede Zeile erklärt, was Sie sehen. Die Leer..."
  ...
story ended at step 35
visited 32 of 32 items
line overflow at 960 x 540: none
de fallback lines: 1 of 29 met (no translation, the base text shown): floor-2
de stale lines: 1 of 29 met (translated from an older base text): text-thought
```

A fallback line has no German text, so readers see the original there.
A stale line's original has changed since it was translated; it still
shows. Each names up to ten item ids in manifest order, or says `none`.
Neither changes the exit status: they are the validator's warnings, met
in play. The validator reports every line of every language, met or not;
`--lang` shows what a walk in that language meets. `--lang` with the
game's own language says `language en: the game's own, no translation
to check`.

A game that opens in another language than the one asked for fails the
run (exit 1) and says which: its language file did not load, or the
folder's player is older than translations (Upgrading to a newer
Kinetic). `openGame`'s `language` option does the same in a test script.

### A test script

Write your test anywhere, as a Node script that imports the testing
library by the absolute path `kinetic check --library` prints:

```sh
kinetic check --library
```

```text
/Users/you/kinetic-venv/lib/python3.13/site-packages/kinetic_extract/data/check/kinetic.mjs
```

From a release that file is the whole library, puppeteer-core inside,
so the script needs no npm and no `node_modules`; in a checkout it is
`player/scripts/testing/kinetic.mjs` (Setting up the tests). The path
changes when you reinstall Kinetic into another venv, so this script
takes it as its first argument and imports it with `import()`. A
script kept with a checkout can import that checkout's path directly
instead: `import { openGame } from
"/path/to/kinetic/player/scripts/testing/kinetic.mjs";`.

This one tests the demo; assemble it in a checkout, from its root, with
`.venv/bin/kinetic assemble fixtures/demo demo-play`, and put your own
game's ids and lines in place of the demo's:

```js
// test-demo.mjs: node test-demo.mjs <library> <game-folder> [webkit|chrome]
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [library, folder, engine = "auto"] = process.argv.slice(2);
const { openGame } = await import(pathToFileURL(library).href);
const profile = "test-profile"; // keeps progress between the two opens
rmSync(profile, { recursive: true, force: true }); // start as a new reader

// Play all routes off, so the test answers the choice itself.
const game = await openGame(folder, { engine, profile, playAll: false });
assert.equal((await game.current()).id, "intro-title");

// Walk to the first choice and take its second route.
const atChoice = await game.spaceUntil((now) => now.choice !== null);
assert.equal(atChoice.choice.prompt, "Demo decision: which route?");
const route = await game.pickRoute(2);
assert.equal(route.id, "route2-start");
assert.equal(route.speaker, "Mei");
assert.match(route.text, /^Route 2: a separate path/);

await game.screenshot("shots/route-2.png");
await game.checkMedia(); // every picture and video the walk passed
assert.deepEqual(game.errors(), []);
await game.close();

// Open again with the same profile: the game resumes on the same item.
const again = await openGame(folder, { engine, profile });
assert.equal((await again.current()).id, "route2-start");
assert.deepEqual(again.errors(), []);
await again.close();
console.log(`${game.engine}: ok`);
```

`node test-demo.mjs "$(kinetic check --library)" demo-play webkit` and
the same with `chrome` each print `ok`. A failed check stops the script
with an error naming what was on screen. Await `checkMedia()` before
reading `errors()` after any walk: a walk faster than a reader moves
past pictures and videos before they finish loading, and a load cut
short reports no error, so a broken file would otherwise pass.

#### Starting from a saved state

To test what a reader sees on coming back, such as a route that starts
or ends where they left it, or a choice remembering the routes they
played, give `openGame` a `savedState`: the record the player keeps
for the story in the browser. The game then opens as for a reader who
saved it, on either engine, with no walk to get there. Take the record
from a game the test has walked, with `savedState()`, or write it by
hand:

```js
// Inside Route 1 of the demo, at its first item, Route 1 played.
const record = {
  ctx: {
    lastShown: "route1-start",
    visited: [],
    stack: [{ decision: "outer", route: "route1" }],
    playedRoutes: [{ decision: "outer", routes: ["route1"] }],
    completedRoutes: [],
  },
  helpSeen: true,
};
const game = await openGame(folder, {
  engine,
  savedState: record,
  playAll: false,
});
assert.equal((await game.current()).id, "route1-start");
assert.equal(game.storageKey, "story:kinetic-demo");
const next = await game.spaceUntil((now) => now.choice !== null);
assert.equal(next.choice.prompt, "Nested decision inside Route 1:");
await game.close();
```

`savedState()` resolves with the whole record as the player keeps it at
that moment, or `null` before it has saved one. The player saves as
the screen changes, so after a press, wait until the record shows the
new place before reading the rest of it.

The record's shape is the player's own, `PersistedState` in
`player/src/storage/types.ts` (the head of
`player/src/storage/idb.ts` says where it is kept), and it can change
with a newer Kinetic: use it in tests only, and take records from
`savedState()` of a folder with the same player when you can. In
`ctx`, `lastShown` is the item on screen, `stack` the routes open
around it (outermost first), `playedRoutes` and `completedRoutes` the
routes played and finished at each decision, and `visited` the items
seen, by id; `settings` holds the Esc screen's settings the reader
changed, and `helpSeen: true` that they have closed the first Esc
screen. A record the player cannot read opens as a new reader would.

### Checking the sound

`current()` reports the game's sound as `audio` (What the library
offers, below), so a test can check what plays at each item with no
window and nothing heard: both engines play the sound, and the library
tells the player to hold its output at zero on every page it opens, on top
of Chrome's missing audio device and the WebKit helper's mute. This one
checks the audio demo's first music; assemble it with
`.venv/bin/kinetic assemble fixtures/audio-demo audio-demo-play`:

```js
// test-sound.mjs: node test-sound.mjs <game-folder> [webkit|chrome]
import assert from "node:assert/strict";
import { openGame } from "/path/to/kinetic/player/scripts/testing/kinetic.mjs";

const [folder, engine = "auto"] = process.argv.slice(2);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const game = await openGame(folder, { engine });

// Read on to the first music: the target names what should sound there.
const now = await game.spaceUntil("music-start");
assert.deepEqual(now.audio.target, {
  music: "calm", ambience: [], voice: null, videoSound: null,
});

// After its 1 s fade-in, the tune plays at its full level.
await sleep(1500);
const { unlocked, elements } = (await game.current()).audio;
assert.ok(unlocked);
const calm = elements.find((e) => e.slot === "music" && e.track === "calm");
assert.ok(calm && !calm.paused && calm.volume > 0.98);
assert.deepEqual(game.errors(), []);
await game.close();
console.log(`${game.engine}: ok`);
```

`node test-sound.mjs audio-demo-play webkit` and `node test-sound.mjs
audio-demo-play chrome` each print `ok`. In both engines, as in any
browser, the player plays nothing until the reader presses a key or
clicks (here the first Space), and `unlocked` stays false until then,
though `target` is already set; only the Mac and Windows apps play from
the start. Reading on (Space,
auto-forward or a pick) applies an item's sound at once; after a wheel
step, a jump or a reload the player waits 250 ms first, so wait a little
longer before reading `target` there. A one-shot is listed (slot `sfx`)
only from its `delayMs` on, and only when the walk reads onto its item:
the wheel, jumps and skip never fire one.

### The item trace

A check that must know every screen the player showed, in order, can
ask the player to record them. Polling the page is not enough: during
a Tab skip burst the player passes items faster than a poll, and its
saved place is written less often than it moves. The trace is for
tests only. Readers never see it, the Mac and Windows apps never turn
it on, and with it on nothing sounds or runs differently.

#### Turning it on

Set `window.KINETIC_TEST_TRACE = true` in the page before the player
starts. The player reads the flag once, as it starts; setting it later
does nothing, and without it the player defines no trace at all. With
your own browser driver, run a script before `app.js` loads, such as
puppeteer's `evaluateOnNewDocument` or Playwright's `addInitScript`:

```js
// Runs in the page before app.js.
window.KINETIC_TEST_TRACE = true;
document.addEventListener("kinetic:item", (event) => {
  console.log(JSON.stringify(event.detail));
});
```

`openGame` and check-game set it for you (below).

#### The records

The player appends each record to `window.__kineticTrace`, an array it
creates, and dispatches the same record on `document` as a
`kinetic:item` event, its `detail` the very object the array holds.
Records are frozen plain JSON. Add the listener before the player
starts too, or the event for record 0 is gone; the array still has it.

Every record has these fields:

- `n`: counts every record from 0, so a gap shows. It starts again at
  0 on each page load, a reload included, with a new array.
- `kind`: `"item"`, `"choice"` or `"end"`.
- `itemId`: the item on screen. For a choice, the item it is drawn over.
- `routeStack`: the open routes, outermost first, each `{ decision,
  route }` by id, as the saved place has them. `[]` on the main line.
- `playAll`: Play all routes is on.
- `skipping`: a Tab skip is running.

An item record also has `type` (`image`, `animation`, `video` or
`text`) and `arrival`, how the reader got there:

- `read`: Space, auto-forward or a pick (Play all's included), and a
  join reached by reading on.
- `skip`: a step of a Tab skip burst.
- `walk`: a wheel step.
- `jump`: `e`, `u`, a bookmark, a branch-map click, and the load.

A choice record also has `decisionId`, `routes` (the route ids offered,
in order), `returnRow` (the "Return to main route" row is offered),
`autoPick` (Play all is answering it with its countdown) and `walked`.
`walked` is true on a choice screen the reader browsed onto, with the
wheel or a branch-map click on the decision, rather than one that
opened by reading; a pick from it still enters the route. An end record
has only the common fields.

From check-game's walk of the demo, the first choice, the item Play
all's pick led to, and the end:

```text
{"n":23,"kind":"choice","itemId":"branch-decide","decisionId":"outer","routes":["route1","route2"],"returnRow":false,"autoPick":true,"walked":false,"routeStack":[],"playAll":true,"skipping":false}
{"n":24,"kind":"item","itemId":"route2-start","type":"image","arrival":"read","routeStack":[{"decision":"outer","route":"route2"}],"playAll":true,"skipping":false}
{"n":36,"kind":"end","itemId":"after-end","routeStack":[],"playAll":true,"skipping":false}
```

#### When records are written

- The screen the load shows is record 0, an item record with arrival
  `jump`.
- One item record per arrival at a screen: every Space, pick, wheel
  step, jump, and every item of a skip burst, each once, in order.
- A choice record each time a choice screen opens: on a new arrival,
  on Space at the decision's item (a choice record with no item record
  before it), and when a route's end offers the choice again,
  Play all's re-offers included.
- An end record each time the end card shows. A story with no
  decisions shows no end card when read to its end, so its trace has
  no end record.
- When one press makes both, the item record comes before its choice
  or end record.

Nothing else writes a record: not a video's view steps (Camera views in
one video: segments), an item settling, a settings change, the Esc
screen or map opening, nor the steps of Play all's countdown. When a
route's end offers the choice again, that route has already closed: the
re-offer's `routeStack` holds only the routes open around the decision,
`[]` for a decision on the main line. Record 0 shows the setting as the
profile had it at the load: after `openGame` with `playAll: false`,
record 0 can still say `playAll: true`, since `openGame` turns Play all
off after the load.

#### Reading it, and the cap

Read the array from the page whenever you like. To make room, empty it
in place; the player keeps appending to that same array, so do not
replace it:

```js
// Runs in the page: takes the records so far and empties the array.
const records = window.__kineticTrace.slice();
window.__kineticTrace.length = 0;
const dropped = window.__kineticTraceDropped;
window.__kineticTraceDropped = 0;
```

The array holds at most 200,000 records. Past that a record is not
appended, but it still gets its `n` and its event, and
`window.__kineticTraceDropped` (0 at the start) counts it. You may
reset the counter; the player adds to whatever it finds there.

#### An older player

The trace ships in Kinetic 1.10.0. A folder with an older player still
plays with the flag set, but once its first screen shows the page has
no `__kineticTrace`. To say why, read the folder's player version from
its `app.js` on disk: `folderKineticVersion(folder)` from
`player/scripts/version.mjs` in this repo, or
`kinetic_extract.version.folder_player_version` in Python, gives the
version, or `null` for a player built before Kinetic 1.8.0. Upgrade an
older folder's player (Upgrading to a newer Kinetic). A player built
from a checkout between releases (`1.10.0-dev`) may predate the trace,
so the array, not the version, is the sure test.

For only the item on screen now, any current player names it on the
stage: `document.getElementById("stage").getAttribute("data-item")`,
the attribute `current()` reads. A poll of it misses the items of a
skip burst; the trace does not.

#### In a test script

`openGame(folder, { trace: true })` sets the flag before the player
starts, on every load. The game's `trace()` resolves with `{ records,
dropped }`: the records since the last call, oldest first, and how many
the player dropped past its cap since then. Each call empties the
page's array and resets the counter, so call it often on a long walk.
After a `reload()` the trace starts again from `n` 0, so read it before
reloading. On the demo:

```js
// test-trace.mjs: node test-trace.mjs <game-folder> [webkit|chrome]
import assert from "node:assert/strict";
import { openGame } from "/path/to/kinetic/player/scripts/testing/kinetic.mjs";

const [folder, engine = "auto"] = process.argv.slice(2);
const game = await openGame(folder, { engine, trace: true, playAll: false });

// Record 0 is the load's screen, traced before openGame turned Play all off.
const opening = await game.trace();
assert.deepEqual(opening.records, [
  {
    n: 0, kind: "item", itemId: "intro-title", type: "image",
    arrival: "jump", routeStack: [], playAll: true, skipping: false,
  },
]);

// Read on to the choice and take route 2.
await game.spaceUntil((now) => now.choice !== null);
await game.pickRoute(2);
const { records, dropped } = await game.trace();
assert.equal(dropped, 0);
assert.equal(records[0].n, 1); // n carries on from the last call

const choice = records.find((r) => r.kind === "choice");
assert.equal(choice.decisionId, "outer");
assert.deepEqual(choice.routes, ["route1", "route2"]);
assert.equal(choice.autoPick, false);

const last = records.at(-1);
assert.equal(last.itemId, "route2-start");
assert.deepEqual(last.routeStack, [{ decision: "outer", route: "route2" }]);
assert.deepEqual(game.errors(), []);
await game.close();
console.log(`${game.engine}: ok`);
```

`node test-trace.mjs demo-play webkit` and `node test-trace.mjs
demo-play chrome` each print `ok`. `trace()` rejects on a game opened
without `trace: true`, and on a folder whose player keeps no trace,
naming its version and the fix:

```text
trace: the folder's player (Kinetic 1.9.1) keeps no item trace; rebuilding the folder with a current player fixes this (CREATE.md, "Upgrading to a newer Kinetic")
```

A player built before Kinetic 1.8.0 is named as `built before Kinetic
versions were stamped`.

#### With check-game

```sh
kinetic check novel-play --steps all --trace walk.jsonl
```

check-game creates or empties FILE before any browser starts, opens the
game with the trace on, and writes every record to FILE as one JSON
object per line, in the order the player made them: `n` runs from 0
with no gap unless the player dropped some. It drains the trace at the
open, every 100 steps and after the walk, so the page's array never
nears its cap. A view step prints as a step of the walk but writes no
record. After the lines saying how the walk stopped, the summary says
how many records it wrote:

```text
story ended at step 35
visited 32 of 32 items
line overflow at 960 x 540: none
trace: 37 records written to /Users/you/walk.jsonl, 0 dropped
```

A folder whose player keeps no trace exits 1 before the walk, with the
message above. `--trace` with no FILE, or a FILE it cannot write such
as a folder, exits 2 before any browser starts.

### What the library offers

`openGame(folder, options)` resolves with the game. Its options:

- `engine`: `"webkit"`, `"chrome"` or `"auto"` (the default).
- `viewport`: `{ width, height }` in CSS pixels (1280 x 720 by default).
- `profile`: a folder that keeps the reader's progress, bookmarks and
  settings between opens. It is created if missing, and is yours to
  delete. Without it every open is a new reader, whose profile is gone
  at `close()`.
- `closeHelp`: close the Esc screen a new reader first meets (`true` by
  default).
- `playAll`: `true` or `false` switches Play all routes through the Esc
  screen, as a reader would. A new reader has it on, so at a choice
  Space takes the highlighted route; turn it off to pick routes
  yourself. Setting it leaves the Esc screen closed. Without it the
  setting stays as the profile has it.
- `startAt`: an item id. The game opens at that item instead of the
  saved place, entering its routes as `u` does (the URL start, Playing
  the folder). An id the manifest does not have throws before the
  browser starts. A folder whose player is too old to start at an item
  throws once it has opened, saying so; upgrade its player (Upgrading to
  a newer Kinetic).
- `language`: a game language tag, the manifest's `language` or one of
  its `languages` (Translating a game). The game opens showing it, as
  for a reader whose system language it is, and the player's own words
  follow it where Kinetic has them in that language. That holds on a
  game with one language too, and whatever languages the machine running
  the test has, so a check that reads the controls gives the same words
  everywhere: `language: "en"` gives English controls on a German Mac. A
  tag the game does not offer throws before the browser starts; a game
  that opens in another language throws once it has opened (its language
  file did not load, the `profile` holds the reader's other pick, or the
  player is older than translations). The game's `language` is the tag,
  or `null` without the option.
- `mediaChecks`: `false` loads no media file off the page to check it,
  as check-game's `--no-media-check` does: `errors()` then lists only
  the failed loads the page's own elements report, and `checkMedia()`
  throws. `true` by default.
- `trace`: `true` turns the item trace on before the player starts, on
  every load, for `trace()` to read (The item trace, above). `false` by
  default.
- `http`: `true` serves the folder over HTTP on 127.0.0.1, as a web
  host would, and opens it there instead of from disk; `{ port: N }`
  picks the port, otherwise the system picks a free one. The server
  stops at `close()`, and the game's `url` is the page's address. The
  browser keeps progress per site, the port included, so a `profile`
  resumes the place over HTTP only on the same port, and never what an
  open from disk saved. `{ url: URL }` starts no server and opens the
  copy already served at URL, as check-game's `--url` does. `false` by
  default.
- `savedState`: a state record, the object the player keeps for the
  story in the browser (Starting from a saved state, above). It is
  written under the story's storage key before the player reads
  storage, on either engine, so the game opens as for a reader who
  saved it: at its place, unless `startAt` is given, with its routes
  and settings. Only the first load writes it: `reload()` resumes from
  what the player has saved since. With a `profile`, it replaces the
  record the profile holds, while the profile's bookmarks and seen
  items stay, and a `ctx.visited` list in the record adds to the seen
  items. Anything but a plain object or `null` throws before the
  browser starts. Its shape belongs to the folder's player version:
  for tests only. `null` by default.
- `log`: a function given openGame's notes (the engine `auto` chose,
  and any links out of the folder, below), printed to stderr by default,
  or `null` for none.

On either engine, `openGame` notes any symbolic links in the folder that
point outside it, naming up to three:

```text
openGame: 2 symbolic links in this folder point outside it (chain-still.jpg, text-bare.jpg). WebKit and the macOS app cannot read files through such links (Chrome can); copy or hard-link the files into the folder instead.
```

The same words, starting `[error]` in place of `openGame:`, are the
first line of `errors()` on both engines, so a script that expects no
errors fails on Chrome too, where the files load. A file behind such a
link fails to load on WebKit and in the macOS app, so copy or hard-link
your media into the folder rather than linking it from elsewhere. A link
that stays inside the folder is fine.

The game:

- `current()` resolves with what the screen shows: `{ id, index, text,
  speaker, file, choice, screen, foundBy, ambiguous, endCard, segment,
  audio }`.
  - `id` and `index` name the manifest item, or are `null` and -1 on a
    screen no item makes.
  - `text` and `speaker` are the line on screen (`null` when none).
  - `file` is the picture or video on screen.
  - `choice` is `null`, or `{ prompt, rows }` while a choice is open.
    Each row is `{ number, label, seen, next, continue }`: `next` marks
    the route Space takes, `continue` the "Return to main route" row.
  - `screen` is `"esc"` or `"map"` while one is over the story.
  - `endCard` is the words of the player's end card while it shows, at
    the story's end (`"You have seen everything."` once every route has
    been played), else `null`.
  - `segment` is the video view showing (Video segments, above):
    `{ index, count }` with `index` counting from 0, or `null` when none
    is, and always from a player older than segments.
  - `audio` is the sound, `{ unlocked, target, elements }`, or `null` for
    a game without sound or a player older than sound (Checking the
    sound, above). `unlocked` says the game may play: true once a key or
    click other than Esc or a ⌘, Ctrl or Alt shortcut has come, and from
    the start in the Mac and Windows apps. `target` is what should sound
    on this screen, `{ music, ambience, voice, videoSound }` naming
    tracks by id (docs/content-format.md, "What plays at an item"), and
    `null` while sound is off (`v`).
    `elements` lists each sound holding a track as `{ slot, track,
    paused, currentTime, volume }`: `slot` is `"music"`,
    `"ambience"`, `"sfx"` (a one-shot), `"voice"`, `"video"` (a video's
    own sound) or `"sample"` (the Volumes box trying a level). One plays
    while `paused` is false; a track that played to its end stays listed,
    paused. `volume` is the track's `volume` times the reader's volume for
    its group, moving through each fade, and lowered under a video's
    `videoSound` duck.
  - `foundBy` says how the item was named. A folder with a current
    player puts the id of the item on screen on the page, and the
    library reads it: `"player"`. With an older player the library
    finds the item from the line and picture on screen: `"screen"` when
    only one item makes that screen. When two items look the same (a
    repeated line over the same picture), the player's saved place
    decides (`"saved place"`); if even that cannot, `foundBy` is
    `"guess"`, `ambiguous` lists the candidates and `id` is the nearest
    one ahead. On a screen no item makes it is `"none"`.
- `press(key, { times })` presses a key by name: `Space`, `Tab`,
  `Escape`, `Enter`, a letter, a digit, `ArrowUp`, `ArrowDown`,
  `ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`, `Home`, `End`,
  `Delete` or `Backspace`.
- `spaceUntil(target, { limit })` presses Space until `target`: an item
  id, or a function given `current()` that returns true. A step to a
  video's next view counts as a change. It stops with an error at a
  choice while Play all routes is off, when Space changes nothing five
  times running, or after `limit` presses (100 by default).
- `waitForItem(target, { timeout })` and `waitForChoice({ timeout })`
  wait without pressing anything (10 s by default), for timed play such
  as auto-forward (`a`).
- `pickRoute(n)` picks row `n` of the open choice with its digit key (1
  to 9, or 0 for "Return to main route") and resolves with the route's
  first screen. Rows past 9 take `press("ArrowDown")` and
  `press("Enter")`.
- `reload()` reloads the page, as a reader's reload does.
- `screenshot(path)` saves a PNG of the page, making its folders.
- `checkMedia({ items, onProgress, pages, stall, onWaiting })` waits
  until every picture, video and poster the page has been given is
  confirmed loaded or listed in `errors()` as failed. Await it before
  reading `errors()` after a walk. A walk faster than a reader moves
  past files before they finish loading, and a load cut short fires no
  error, so each such file is loaded and decoded off screen, and every
  poster too, since a poster reports nothing when it fails (The media
  check, above). Its options, all optional:
  - `items`: a list of item ids, such as the ones a walk showed. Every
    file they reference that the page was never given is checked too:
    an animation's later frames, a video's file shown only as its
    poster, and each sound track's script, decoded as the player
    decodes it.
  - `onProgress({ checked, total })`: called each time the count of
    files checked changes, the last time with every file checked.
    `total` can grow while it checks, as files the page is still
    loading come in.
  - `pages`: on Chrome, how many pages, each in its own browser context,
    check the files (4 by default; 0 checks them in the game's page, 4
    at a time). WebKit checks 8 at a time in the game's page, whatever
    `pages` says.
  - `stall`: it throws if this many ms (20 s by default) pass with no
    file answered. A video gives up after 15 s, as failed.
  - `onWaiting(count)`: called once before it waits, with how many
    files are left to check, and not at all when none are.

  It resolves with `{ files, failed, loaded, checked, neverRequested
  }`: how many media files the page was given, `items`' files added;
  the URLs that failed; how many had loaded or failed before the check;
  how many it checked; and how many of those the page was never given.
  It throws if a checking page fails, and on a game opened with
  `mediaChecks: false`.
- `errors()` lists the console errors and warnings and the page errors
  so far, as `[error] ...`, `[warning] ...` and `[pageerror] ...`. A
  picture, video, poster or script that failed to load or decode is
  listed once per file, on both engines, as `[error] Failed to load
  resource: <url> (<reason>)`: `not found`, `could not decode`, `not
  readable` or `a symbolic link out of the folder` (Failed loads,
  above). The library reports these itself, since WebKit reports no
  failed load and Chrome reports a missing file but not one it cannot
  decode. After a walk, await `checkMedia()` first.
- `trace()` resolves with `{ records, dropped }`, the item trace's
  records since the last call and how many the player dropped since
  then, emptying the page's array (The item trace, above). It rejects
  on a game opened without `trace: true` and on a folder whose player
  keeps no trace.
- `close()` closes the game; every open needs one.
- `page` is the puppeteer page for anything else (`page.evaluate`,
  `page.mouse.click(x, y)`). In WebKit it offers the subset the player's
  own test suite uses.
- `savedState()` resolves with the story's whole state record as the
  player keeps it now, under `storageKey`, or `null` when it has saved
  none. Its shape is the player's own, as for the `savedState` option.
- `engine`, `folder` and `manifest` say what was opened, and
  `kineticVersion` the Kinetic version of the folder's player, read from
  its `app.js` (`null` for a player built before Kinetic 1.8.0).
- `storageKey` is the key the player keeps the story's progress under:
  `story:<storyId>` for a manifest with a `storyId`, else the folder's
  address as the page has it (`file:///.../`, or the HTTP address with
  `http`).

## Upgrading to a newer Kinetic

A game folder's player is two files, `index.html` and `app.js`; every
other file (`manifest.json`, `manifest.js`, media, the language files
under `lang/`, extras) is your content. To take a newer player's
fixes and features, install the newer release over the old one (From a
release), run setup again, since the pins may have changed, then let
`kinetic upgrade` replace just those two files:

```sh
~/kinetic-venv/bin/pip install https://github.com/sendub/kinetic/releases/download/vX.Y.Z/kinetic-X.Y.Z-py3-none-any.whl
kinetic setup
kinetic upgrade my-novel
```

In a checkout, pull and build the player first:

```sh
git pull
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
.venv/bin/kinetic upgrade my-novel
```

Before upgrading, `kinetic release-status` tells you which release you
installed and whether its work was finished, with no network: the
version, the commit the wheel was built from (with `-dirty` when it
was built from uncommitted changes), how many items of the release's
checklist (docs/progress.md, which the wheel carries) are checked and
how many are open, and the release's CHANGELOG entry. `--json` prints
the same as one object (`version`, `commit`, `clean`, `checked`,
`open`, `changelog`, among others), for a script that upgrades only
when `open` is 0. In a checkout it reads the repo's own files and asks
git for the commit.

`kinetic upgrade` prints the folder's Kinetic version before and
after, and what it replaced, then runs the validator on the folder.
Upgrading a folder made before Kinetic 1.8.0, whose player did not
record its version:

```text
Kinetic unknown -> 1.8.0
my-novel: replaced index.html, app.js
```

A folder that already has this version says `(already current)` after
it, and is upgraded all the same. When the folder holds a schema copy
(Manifest), the second line ends `and manifest.schema.json`: the copy is
replaced with the newer schema. A folder without one gets none.

The command never touches `manifest.json` or `manifest.js`: the shim is
generated from your `manifest.json`, not from the player, so regenerate
it only when you edit `manifest.json` (Generating manifest.js). Media,
`lang/`, extras and the apps stay as they are too; an app in the folder (Building
the apps) plays whichever `index.html` sits beside it, so it keeps
working without a rebuild. Each file is written whole beside the old one
and then put in its place, so an interrupted upgrade leaves the old
player, never half of the new.

It refuses, changing nothing, a folder with no `manifest.json`, and in
a checkout a `player/dist/` that is missing or not built from the
checkout's current version, as after a `git pull` without `npm run
build`:

```text
upgrade_folder: player/dist/app.js is Kinetic 1.7.0, not this Kinetic's 1.8.0; run npm run build in player/
```

The validator then checks the folder against the newer rules, printing
each problem as it does on its own (Validating). The folder stays
upgraded when it reports problems; fix them and validate again:

```text
manifest.json: items[30].file: media file 'after-start.jpg' does not exist in the folder
my-novel: 1 problem
upgrade_folder: my-novel is upgraded, but the validator reports problems (above); fix them and run kinetic validate my-novel
```

(In a checkout the last line names `tools/validate_content.py`.)

The exit status is 0 when the folder is upgraded and the validator
passes (its warnings do not change that), 1 for a refusal, a file it
cannot write or validator problems, and 2 when the folder is not a
directory, the arguments are wrong (`--link-media` without `--to`
among them) or `--to` names a place it cannot use (below).

To see what an upgrade would do first, add `--dry-run`. It refuses as
the upgrade would, prints what it would replace and runs the validator
on the folder as it is, with its old player, writing nothing anywhere;
its exit status is the validator's:

```text
Dry run: nothing is written.
Kinetic 1.12.0 -> 1.13.0
my-novel: would replace index.html, app.js
```

A big delivered folder you want to check before changing it can be
upgraded as a copy first. `--to NEW` makes the new folder NEW, a copy
of the folder with the new player, and only reads the folder. Each
media file the manifest and its language files name (pictures,
animation frames, videos, posters, sound and voice tracks with their
scripts) is hard-linked rather than copied, so the copy takes almost
no space and is made in seconds even with tens of thousands of files.
Everything else is copied: `manifest.json`, `manifest.js`, the
language files, extras, files nothing names and the apps, with their
permissions and symbolic links, so a Mac app's signature still
verifies. A symbolic link in the folder comes over as the same link.
The staged workflow:

```sh
kinetic upgrade my-novel --dry-run
kinetic upgrade my-novel --to my-novel-next
kinetic check my-novel-next --steps all    # and your other checks
kinetic upgrade my-novel
```

The last step upgrades the delivered folder in place with the same
release, which writes the same player files byte for byte as the copy
got, so what you checked is what you ship. Then delete the copy;
deleting it leaves the original's media in place. `--to` prints a
line before the usual ones with how many files it hard-linked and
copied and their sizes, so a staging check can match them, then
validates the copy, with the same exit status as a plain upgrade:

```text
my-novel-next: a copy of my-novel, 4,210 files (1.2 GB) hard-linked and 12 files (31.0 MB) copied
Kinetic 1.13.0 -> 1.14.0
my-novel-next: replaced index.html, app.js
```

Sizes are in decimal units (`999 bytes`, `1.0 kB`, `31.0 MB`, `1.2
GB`), and a symbolic link counts as a copied file. With `--dry-run`
that line reads `my-novel-next: would be a copy of ...`, and the last
says `would replace`.

A game that keeps every media file it has ever shipped, so that
readers' saved places and bookmarks still find theirs, holds many
files under `media/` that the current manifest no longer names. `--to`
copies those in full, and says so in a second line:

```text
my-novel-next: a copy of my-novel, 4,210 files (1.2 GB) hard-linked and 2,612 files (803.5 MB) copied
2,600 files (772.5 MB) under media/ are named by nothing and were copied; --link-media links them
```

(`would be copied` in a dry run; no such line when there are none.)
Add `--link-media` to hard-link every file under the folder's `media/`,
named or not, as well as the named media elsewhere. Symbolic links
under `media/` stay links, and the files that are never linked (the
player, the schema copies, `manifest.json`, `manifest.js`) stay copied.
A folder with no `media/` folder is copied as without the flag. The
staged workflow for such a game:

```sh
kinetic upgrade my-novel --to my-novel-next --link-media --dry-run
kinetic upgrade my-novel --to my-novel-next --link-media
kinetic check my-novel-next --steps all    # and your other checks
kinetic upgrade my-novel
```

```text
my-novel-next: a copy of my-novel, 6,810 files (2.0 GB) hard-linked and 12 files (31.0 MB) copied
```

`--to` refuses, writing nothing, with exit status 2: a NEW that
already exists, a NEW inside the folder or holding it, a NEW whose
parent folder does not exist, and a NEW on another volume (disk) than
the folder, since hard links cannot cross volumes. It builds the copy
in a hidden folder beside NEW (`.my-novel-next.<random>.upgrading`)
and renames it to NEW only when the copy is complete and upgraded, so
a failure, such as a full disk, or Ctrl-C leaves no NEW. A hard link
that fails stops the copy the same way, with or without `--link-media`:
the file is never copied instead, and no NEW and no copied file is
left. Only a process killed outright can leave that hidden folder
behind; delete it.

The copy's media share storage with the original's: a media file
edited in place in the copy, say by an image editor saving over it,
changes in the original too. To change one in the copy alone, delete
it there first and write the new file in its place. The upgrade itself
never writes a media file.

If you copy the player by hand instead, in a checkout, copy only
`index.html` and `app.js` from `player/dist/`: its `manifest.js` is an
empty placeholder that would overwrite your game's own (the validator
then reports that it does not equal `manifest.json`).

To see which Kinetic you have: the Esc screen shows the player's version
small in its bottom-right corner, below the sheet (`Kinetic 1.8.0`);
`kinetic --version` (and `--version` on every subcommand and old command
name) prints the installed one's, as `Kinetic 1.8.0`; and check-game's
first line names the folder's (The quick check). A checkout between
releases reads as the next release with `-dev`, such as `1.9.0-dev`.
CHANGELOG.md lists what each release changed, and marks with
**Upgrading:** anything a release asks of you beyond running the
command.

A game with sound made before audio scripts existed fails the validator
once per sound file, with `no script '<file>.js' beside it`. Write the
scripts as Sound, above, says (`kinetic assemble` writes every
missing one), or ship the sound again: kinetic extract, and kinetic media
with `"loops": true` on looping tracks, write the scripts and also move
looping MP3 and Opus tracks to a loop-safe format, which the validator
otherwise warns about.

Readers keep their progress. The player saves it in each reader's
browser under the manifest's `storyId`, not inside the folder, so the
new player picks it up on the next open. A manifest without a `storyId`
keys progress by the folder's location instead; add one (see Manifest)
and the first open carries that progress over to it.

The player saves the items a reader has seen apart from the rest of
their progress, so a save on a screen change costs the same however
much they have read. Older players kept the seen items in the main
record and rewrote it on every screen change. The browser database kept
its version through that change, so folders with older players still
open, and the first open with the new player moves a reader's old
progress over. A reader who goes back to a folder of the same story
with an older player, in the same browser, sees fewer items marked as
seen there; their place and played routes are intact, and nothing is
lost when they come back to the new player. Reset progress and Import
in the older player cannot reach the seen marks the new one keeps, so
after a Reset there and some reading, the new player still marks the
earlier items seen.

Your test scripts may notice the newer Kinetic too. A script that read
the player's saved state directly finds the state record's
`ctx.visited` list empty; for a coverage verdict, run
`kinetic check --steps all` (The quick check) instead. A script that
seeds a profile's saved state with a `ctx.visited` list, to start as a
reader who has read that far, still works: at load the player merges
the list into its own seen records and empties it. The records keep
what they had, so seeding twice in one profile adds up: the second
list joins the first rather than replacing it. To start clean, open
with a fresh profile (openGame's default, no `profile`), or delete the
profile's seen records before seeding: in the `kinetic` database's
`state` store, each record whose key is an array starting `"seen"` and
the story's storage key, `["seen", <storage key>, <page>, <n>]`
(`story:<storyId>` for a manifest with a `storyId`; the schema at the
head of player/src/storage/idb.ts gives every key).

The testing library now lists Chrome's console warnings, which it used
to miss, and fails a picture or video Chrome cannot decode, which used
to pass there, so a test that passed on Chrome may now report them. A
symbolic link out of the folder now fails on Chrome as well as WebKit
(Symbolic links out of the folder). check-game checks every file a
shown item references, so an animation frame or sound script a fast
walk never reached can now fail it, and its `--until` walks as `--steps
all` does unless `--steps` is given, exiting 3 when its span has items
not shown (Checking part of a game). A folder with an older player
still tests, but the library names its items from the screen, and
`startAt` and `--start-at` refuse it (exit 1); upgrading its player
fixes both.

Re-extract instead when the fix is in the converter (`kinetic extract`)
rather than the player, or when the validator rejects a folder the older
Kinetic accepted, such as a manifest whose `schemaVersion` the newer
tools no longer take. Run `kinetic setup` first (the new release may
have changed the pinned tools), then extract into a new folder with the
same `storyId` (the extractor derives the same one from the same
project; otherwise pass `--story-id`, and for episodes keep their
order), run the checks of Converting, checking and playing one game,
assemble, and replace the old folder. A folder converted with other
pinned tools rebuilds only with the Kinetic release or commit that made
it (Checking a folder with rebuild). Progress is saved by item id, so
items that keep their ids keep their seen marks and the reading
position; ids that no longer exist drop out of it. A folder converted
before Kinetic 1.12.0 gains speaker colours and transitions only this
way, and the walk from `label start` may change which items it holds and
their ids (CHANGELOG.md, 1.12.0); one converted before 1.15.0 gains
its jump menus, conditions, one-choice lines and frame-by-frame
animations only this way, with more items and new ids after the first
change (CHANGELOG.md, 1.15.0). A hand-authored folder follows
docs/content-format.md for the new `schemaVersion` instead.
