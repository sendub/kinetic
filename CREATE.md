# Making a New Kinetic Game

Kinetic plays a kinetic visual novel from a content folder: a manifest
listing images, animation frame sets, videos, and `text` dialogue lines
in play order, plus the media files the manifest references. Two paths
produce such a folder from content you already have (images, an
animation frame set, a video, and the text you want overlaid):
hand-authoring it, or converting a Ren'Py project with the extractor.
Both produce the same format, and you validate and play the result the
same way either path took.

docs/content-format.md specifies the folder and docs/content-schema.json
defines the manifest; this guide adds the commands.

## Hand-authoring a content folder

### Layout

The folder holds everything the novel needs. There are no absolute paths
and no network access at play time:

```text
my-novel/
  manifest.json    # source of truth, written by hand
  manifest.js      # generated shim, one command, see below
  *.jpg, *.mp4     # media, named per the conventions shown below
                   # (optionally under a subfolder: media/ab/window-004.jpg)
```

`index.html` and `app.js` are the player bundle, copied in as the last
step before playing (see "Playing the folder"). A content folder without
them is still valid input for the validator.

### Manifest

`manifest.json` carries `schemaVersion` (1), an optional `storyId`, an
optional `title`, the display `width` and `height` in pixels, and
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
one the help screen has no heading and the tab reads `Kinetic`. Each item has a unique
`id` (letters, digits, `-`, `_`, starting with a letter or digit), a
`type`, and the fields its type requires:

- `image`: `file`, one image at display resolution. `.jpg`, `.png`,
  `.webp`, `.gif`, and `.jxl` are allowed; `.jxl` needs Chrome/Edge
  117+, Safari 17+, or Firefox 133+.
- `animation`: `frames` (at least two, at display resolution, in play
  order), `fps` greater than 0, `loopCount` of at least 1.
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
  underneath it.
  A `text` chain advances on text holds alone, never gated on media
  end. The first item may not be `text`, and a `text` item needs a
  media item before it.

Any item may also carry `speaker` and `text` for the overlay; no `text`
means a bare visual with nothing drawn. A line may be marked with
`thought: true` to show it as the `speaker`'s unspoken thoughts rather
than spoken dialogue; the player draws the two differently. `thought`
defaults to `false` and needs a non-empty `text`. No other fields are
accepted. Media paths are relative to the folder, use POSIX separators,
and contain no spaces and no `..` segments.

A complete minimal manifest: one image, one animation, one video, and
two `text` lines that run over the looping video:

```json
{
  "schemaVersion": 1,
  "storyId": "rainy-day",
  "title": "Rainy Day",
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
content instead; see "Converting a Ren'Py project" below.) The names above
are the last segment of the path: a `file`, `poster`, or `frames` entry
may sit in a subfolder of the content folder, such as
`media/ab/window-004.jpg`. The path stays relative to the content
folder: forward slashes, no leading `/`, no `..`, no drive letter, no
backslash, and the last segment keeps the flat name. Subfolders are
never a requirement; a folder you author by hand may stay flat. A folder may also
carry extra unreferenced files, such as the converter's build ledger; the
player and the validator ignore them.

A video item may play a sub-range of its file: `startSeconds` (at
least 0, default 0) and `endSeconds` (greater than `startSeconds`,
default `durationSeconds`). Both are exact fractional seconds, never
rounded; playback runs to `endSeconds` and its `ended` fires at the
range end. Several items may reference the same file at different
ranges, so one clip can serve several beats. To count in frames
instead, store `startFrame / fps` and `endFrame / fps` as the
seconds; the player never sees frame numbers.

A looping video may restart its later passes somewhere else:
`loopStartSeconds` (at least 0, default `startSeconds`) is where
playback resumes once a pass reaches `endSeconds`, so a clip with an
intro plays the intro once and skips it on every loop-back. It is an
exact fractional second like the rest, and must stay below the range
end; coming back to the item later plays the intro again. The poster
is unaffected and stays the frame at `startSeconds`.

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
`result: "ending"`, so its last item IS that route's ending. To set a
scene change, author a `text`-only item or title image at a route's
start or end — the format needs no transition field. The validator
accepts this manifest; `tools/data/branches-example` carries exactly
this folder.

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

### Validating

Run the validator from the repo root; it needs the jsonschema library,
which lives in the repo venv:

```sh
.venv/bin/python tools/validate_content.py my-novel
```

A clean run prints nothing and exits 0. A broken folder prints one line
per problem, shaped like
`manifest.json: items[1].fps: must be greater than 0 (found 0)`, plus a
problem count on stderr, and exits 1. The validator checks the schema
plus the filesystem invariants in docs/content-format.md: every
referenced file exists inside the folder, item ids are unique, each
video's playback range fits inside its `durationSeconds`, and a
present `manifest.js` embeds JSON equal to `manifest.json`.

## Converting a Ren'Py project

The extractor, `kinetic-extract`, turns a Ren'Py project (a folder
holding `game/`, the `game/` folder itself, or a macOS `.app`) into
exactly the folder format above. It reads `.rpy` scripts, decompiles
`.rpyc` (vendored unrpyc) and reads `.rpa` archives, converts simple
`menu:` blocks into branches (conservatively, never guessing joins),
and does the media work you do by hand above: it sniffs true formats,
keeps browser-compatible originals byte-identical or ships them as
lossless JPEG XL when that is smaller, keeps video Safari and Chrome
both play, remuxes H.264/HEVC/VP9 from a container one of them refuses
(MKV, AVI, MPEG-TS) into MP4 without re-encoding, transcodes only other
codecs, and makes lossless posters (PNG, or JPEG XL when smaller).
Every media file it ships, posters included, is named by the sha256 of
its bytes,
`media/<h[:2]>/<h>.<ext>` (docs/extracting.md, "Output layout").

The conversion is reproducible: the same game gives the same bytes and
paths on any machine whose pinned tools pass the self-test, and the
folder's build ledger records how to make every media file again from
the original game files, so anyone holding the game can check a folder
with `kinetic-media rebuild`.

The steps below use one example game throughout: Rainy Day, released
in two episodes at `~/games/RainyDay/Ep1` and `~/games/RainyDay/Ep2`,
converted into `~/games/RainyDay-Kinetic`. Replace those with your
paths. Run every command from the root of your Kinetic checkout unless
a step says otherwise.

### Setting up the tools

Once per checkout (create the venv first if `.venv/` is missing:
`python3 -m venv .venv`):

```sh
.venv/bin/pip install -r requirements.txt --cache .tmp/pip-cache
.venv/bin/pip install -e ./converter --cache .tmp/pip-cache
.venv/bin/python tools/setup_media_tools.py
```

The pip lines install the pinned Pillow, imagecodecs (libjxl) and
numpy, and the converter. The setup script downloads the pinned static
ffmpeg and ffprobe for your OS and architecture into `.media-tools/`,
checks their sha256, and runs a self-test: every media tool path runs
on committed samples and each output's sha256 must equal the pinned
"golden" value. A good run ends:

```text
setup_media_tools: self-test passed (15 cases)
setup_media_tools: media tools ready in .../.media-tools/macos-arm64
```

The converter uses only these tools, never the ffmpeg on your PATH,
and refuses to run until this self-test has passed. Run all three
commands again after a `git pull` that changes `requirements.txt` or
`converter/media-tools.json`.

Two flags change the pins in `converter/media-tools.json`; commit the
file after either:

- `--pin`: the first setup on a platform whose archive checksums are
  still null (the pin file lists `macos-arm64`, `macos-x86_64`,
  `linux-x86_64` and `linux-arm64`; only `macos-arm64` is pinned so
  far). It records the archives' sha256s. The golden values are shared
  by every platform and must still match, so `--pin` cannot hide a
  platform whose tools give different bytes.
- `--repin CASE`: only after a deliberate change to a media recipe in
  the converter changes one self-test case's output. It re-records that
  case (repeatable) and prints old and new values; every other case
  must still match.

Reference: converter/README.md, "Pinned media tools".

### Converting, checking and playing one game

```sh
.venv/bin/kinetic-extract ~/games/RainyDay/Ep1 ~/games/RainyDay-Kinetic
.venv/bin/python tools/validate_content.py ~/games/RainyDay-Kinetic
cp player/dist/index.html player/dist/app.js ~/games/RainyDay-Kinetic/
.venv/bin/kinetic-media rebuild ~/games/RainyDay/Ep1 ~/games/RainyDay-Kinetic
```

1. `kinetic-extract` prints a summary: item and media counts, the
   display size, the story id and title with where each came from, and
   one line per statement it skipped and per item note (`jxl 131 <
   original 602`, `shares shipped file ...`). Read the
   `items skipped` count and any `warning:` lines (When something
   fails, below).
2. The validator prints nothing and exits 0 on a good folder.
3. The `cp` adds the player (run `npm run build` in `player/` first if
   `player/dist/` is missing or stale). Double-click `index.html` to
   play (Playing the folder, below).
4. `rebuild` makes every media file again from the original game and
   compares hashes; it ends `rebuild OK` (Checking a folder with
   rebuild, below).

To try a big game on part of its story first, add `--label NAME`,
`--max-items N` or `--files GLOB` (converter/README.md, "Usage").

When you convert again after a change that drops media (a different
game version, other options), use a new or empty folder: the extractor
never deletes files, so media left over from the earlier run stays in
`media/` and `rebuild` reports it as `not in the ledger`.

The extractor names the game and the story: the `title` is the
project's `config.name` (else its folder name, with `_` and `-` read as
spaces), and the `storyId` is derived from `config.save_directory`,
`config.name` or the folder name. Set either with `--title "Rainy Day"`
and `--story-id rainy-day` (the id must already be a valid `storyId`),
or edit `manifest.json` afterwards and regenerate `manifest.js`
(Generating manifest.js). Keep the `storyId` when you convert an
updated game, so readers' progress follows it.

### Several episodes, one game

A game released in episodes becomes one game: list the episodes in
story order before the output folder.

```sh
.venv/bin/kinetic-extract ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 \
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
.venv/bin/kinetic-media rebuild ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 \
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
> modelled on a wrapper seen in game I but is NOT a correct
> decoder for that game: its episodes 4-5 use an activation-dependent
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
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-extract \
    ~/games/RainyDay/Ep1 ~/games/RainyDay/Ep2 ~/games/RainyDay-Kinetic \
    --title "Rainy Day" --story-id rainy-day --decoder rainy_unwrap:decode
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-media rebuild \
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

### Writing your own converter: kinetic-media ship

A game the extractor cannot read well (its own story format, screens
instead of `say` statements) gets a game-specific helper: your own
code builds the story, and `kinetic-media ship` does all the media
work, with the same tools, policies, decoder hooks and
content-addressed `media/` layout as `kinetic-extract`. The helper
writes `manifest.json` itself. It replaces `kinetic-extract` for that
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
   "source": {"path": "Ep1/game/data/clip.mp4"}}
]
```

A source inside an `.rpa` archive is
`{"archive": "Ep1/game/images.rpa", "member": "bg/room.jpg"}`. A
video's poster is the frame at `startSeconds` (default 0).
`requests-ep2.json` lists episode 2's sources the same way. Ship each
episode into the same folder, from the helper's folder:

```sh
cd ~/games/rainy-kinetic
KINETIC=~/src/kinetic        # your Kinetic checkout
PYTHONPATH=. $KINETIC/.venv/bin/kinetic-media ship ~/games/RainyDay \
    ~/games/RainyDay-Kinetic --list requests-ep1.json \
    --decoder rainy_unwrap:decode
PYTHONPATH=. $KINETIC/.venv/bin/kinetic-media ship ~/games/RainyDay \
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

Each run prints `requests: 2; shipped: 2; skipped: 0` and merges into
`~/games/RainyDay-Kinetic/media-ledger.json`; shipping the same list
again changes nothing. That ledger's `requests` pair each request with
its `result`. A result with a `file` gives the manifest item's media
fields; one without a `file` was skipped, and its `decision` and
`notes` say why. Your helper drops a skipped item. A sketch of reading
it (`media_items.py`):

```python
import json


def media_items(folder):
    """Request id -> the media fields of its manifest item."""
    with open(f"{folder}/media-ledger.json", encoding="utf-8") as f:
        ledger = json.load(f)
    items = {}
    for entry in ledger["requests"]:
        request, result = entry["request"], entry["result"]
        if "file" not in result:      # skipped: drop the item, say why
            print("skipped", request.get("id"), result["decision"],
                  result["notes"])
            continue
        if request["kind"] == "image":
            items[request["id"]] = {"type": "image", "file": result["file"]}
        else:
            items[request["id"]] = {
                "type": "video", "file": result["file"],
                "poster": result["poster"],
                "durationSeconds": result["durationSeconds"],
                "startSeconds": request.get("startSeconds", 0)}
    return items
```

The result's `width` and `height` give the display size. The helper
then writes `manifest.json` with these items in story order, generates
`manifest.js` (Generating manifest.js), and the folder is validated,
played and rebuilt like any other:

```sh
cd ~/src/kinetic
.venv/bin/python tools/validate_content.py ~/games/RainyDay-Kinetic
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-media rebuild \
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
PYTHONPATH=. $KINETIC/.venv/bin/kinetic-media ship ~/games/RainyDay \
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

`kinetic-media rebuild` reads the folder's `build-ledger.json` and/or
`media-ledger.json`, finds every original source under the game
root(s), checks its sha256, runs the recorded steps again, and checks
each output's sha256 and the folder's `media/` (no file missing, extra
or altered). It never uses the reuse cache. Exit 0 and `rebuild OK`
mean every media file is exactly what this game and these tools make.

To verify a folder on another machine, that machine needs:

- the same OS and architecture: the ledger records the ffmpeg binary's
  sha256, and a rebuild refuses tools that differ (exit 2);
- a Kinetic checkout at the commit that made the folder, set up as in
  Setting up the tools (note the commit when you share a folder);
- the original game files, and the same decoder hooks.

Then run the same rebuild command with that machine's paths. Add
`--out DIR` to also write the rebuilt `media/` tree into `DIR`, which
reproduces a folder's media from its ledger and the game alone.

Reference: docs/extracting.md, "kinetic-media rebuild".

### Checking posters before delivery

A video item's poster must be the frame at its `startSeconds`: the
player shows it in skip, rewind and under text lines. A helper that
ships a video once (at 0) and then uses it for items starting later
gets frame-0 posters on those items. Before you deliver a folder, check
every video item's poster against the ledger:

```sh
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-media posters \
    ~/games/RainyDay ~/games/RainyDay-Kinetic --decoder rainy_unwrap:decode
```

Use the same game root and `--decoder` hooks as the ship. To check a
draft manifest kept outside the folder, add `--manifest
path/to/manifest.json`. A good run exits 0 and ends `posters: N video
items: N checked, N passed (...), 0 failed, 0 skipped (first frame)`.
Exit 1 lists each wrong poster on a `FAIL <id>: ...` line with the
item's `startSeconds`, the start the ledger records for its poster and
the pixel difference. The check writes nothing.

To fix them, add `--fix` and say where the remap goes:

```sh
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-media posters \
    ~/games/RainyDay ~/games/RainyDay-Kinetic --decoder rainy_unwrap:decode \
    --fix --remap ~/games/rainy-kinetic/poster-remap.json \
    --out ~/games/rainy-kinetic/poster-requests.json
```

It ships one poster per distinct video and `startSeconds` into the
folder, as `kinetic-media ship` would (videos are reused, only posters
are made), and writes the remap: item id -> new poster. `--out` keeps
the requests it shipped. It does not touch your manifest: set each
remapped item's `poster` (or have your helper use the new results),
regenerate `manifest.js`, and run the check again, which now exits 0.
Running `--fix` again before you apply the remap changes nothing. An
item it cannot fix (`NOT FIXABLE <id>: ...`, for example a video the
ledger has no entry for) makes it exit 1; fix that item by hand.

A hand-made folder that cannot decode to seek may keep first-frame
posters (docs/content-format.md, "Video playback ranges"): name those
videos with `--first-frame FILE` (a manifest `file` value, repeatable),
or pass `--first-frame-all`, and they are skipped.

For a quick look without the game files, add `--ledger
~/games/RainyDay-Kinetic/media-ledger.json` to the validator: it reads
the ledger only, decodes nothing, and prints a `warning:` line on
stderr for each poster the ledger records at another start or from
another source, and for each item starting after 0 whose poster it
records no start for. Warnings never change the exit status; the
`kinetic-media posters` check above settles them.

Reference: docs/extracting.md, "kinetic-media posters" (the
validator's warning is under "The validator's cheap check").

### The reuse cache

Encoding (lossless JPEG XL at effort 9, transcodes, posters) is the
slow part of a conversion. `kinetic-extract` and `kinetic-media ship`
remember each encode in `.tmp/kinetic-media-cache/` in your checkout,
keyed by the bytes being encoded (after decoder hooks), the recipe and
the exact tools, so a re-run or a later episode encodes nothing it has
made before and writes the same folder byte for byte.

- `KINETIC_MEDIA_CACHE=DIR` puts the cache elsewhere, for example on a
  bigger disk; `KINETIC_MEDIA_CACHE=off` turns it off for one run.
- Deleting it is always safe (`rm -rf .tmp/kinetic-media-cache`); the
  next run encodes again. Do so to reclaim disk space; the cache only
  grows. Stored outputs are hash-checked when read, so a damaged cache
  never damages a folder.
- `rebuild` never reads it.

Reference: docs/extracting.md, "Reuse cache".

### When something fails

**`media self-test mismatch: the tools would not reproduce the pinned
output, refusing to convert`**, with one line per case such as
`imagecodecs (imagecodecs.jxl-lossless): expected …, got …`. The tools
on this machine do not make the pinned bytes, so a folder made here
would not match one made elsewhere. Re-run
`.venv/bin/pip install -r requirements.txt --cache .tmp/pip-cache` and
`.venv/bin/python tools/setup_media_tools.py --force` (a fresh ffmpeg
download). If it still fails, the platform really differs (a different
build of a wheel or of ffmpeg): report it with the case lines, and do
not `--repin` to make it pass, since that would change the reference
bytes for every machine. The related refusals name their own fix: a
missing install or a changed binary (`run .venv/bin/python
tools/setup_media_tools.py`), codec versions that differ from the pins
(`run .venv/bin/pip install -r requirements.txt ...`), or a platform or
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
it. A remuxed video has no audio track: the player plays video muted.

**`kinetic-extract: <folder>/media/ab/ab12….png: existing file's sha256
is …, not the one its name gives; not replaced (remove it, or use
another output folder)`** (exit 1; `kinetic-media ship` prints the same
line). The output folder already had a file under that content name,
and its bytes are not the ones the name promises: something altered
it. A correct existing file is reused untouched (it may be hard-linked
into another game), but a wrong one is never overwritten. Delete that
file if nothing else needs it, or convert into an empty folder, then
run again. `rebuild --out` reports the same problem as a `FAIL` line.

**`rebuild` exit 2.** It could not start: no ledger in the folder, a
bad game root, tools not ready, or `the ledger was made with other
media tools`, followed by each difference
(`mediaTools Pillow: ledger "12.0.0", now "13.0.0"`). Rebuild with the
Kinetic commit that made the folder, on the same OS and architecture,
or convert the game again with the current tools.

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
| `not in the ledger` | A file in `media/` no ledger lists, often left by converting into a non-empty folder; convert into an empty folder. |
| `absent from the folder` or `folder file differs from the ledger: …` | The folder's `media/` lost or altered a file. Copy the folder again, or rebuild with `--out DIR` (a new folder) and copy `DIR/media/.` over the folder's `media/`. |
| `…: existing file's sha256 is …, not the one its name gives; not replaced …` | With `--out DIR`, a file already in `DIR` under that content name holds other bytes; it is never overwritten. Delete it, or rebuild into a new `DIR`. |

Reference: docs/extracting.md, "kinetic-media rebuild".

## Playing the folder

Copy the built player bundle from this repo into the content folder:

```sh
cp player/dist/index.html player/dist/app.js my-novel/
```

Or let `tools/assemble_folder.py <content-dir> <out-folder>` assemble a
playable copy in one command: it copies the bundle and content, generates
a missing `manifest.js`, and prints the folder size (docs/packaging.md).

Run `npm run build` in `player/` first if the bundle is not current.

Double-click `index.html` to open the novel in your default browser.
The first keypress or click other than Esc puts the player in
fullscreen, so that first keypress can simply be space, the advance key.
A reader who leaves fullscreen goes back on their next key or click,
unless they choose Window on the Esc screen (kept with the other
settings).

The controls are listed in README.md ("Playing").

In auto mode (`a`) the player advances at the configured auto-forward
speed ("Auto-forward speed" in the Esc screen's settings):
images hold for their text, animations complete their loops, and videos
play through once. A media item followed by `text` items holds for its
text alone while its animation or video loops underneath, and each
`text` item holds for the length of its text.

The folder can also hold a macOS app and a Windows program that readers
open instead of `index.html` (Building the apps, below).

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
.venv/bin/python tools/build_apps.py novel-play --mac --windows
.venv/bin/python tools/assemble_folder.py my-novel novel-play --windows --icon cover.png
```

- `--mac` adds `<title>.app`, named from the manifest `title`, with `/`
  and `:` written as `-` (the folder's name when there is no title). The
  manifest needs a `storyId` (Manifest, above), since the app keeps
  readers' progress under its bundle id, `org.kinetic.game.<storyId>`
  (`_` written as `-`). The build refuses a manifest without one. It
  also reads the pixel size of the game's first graphic (see `--icon`)
  into the app, for its first window, and prints it; a game with no
  readable picture gets a 16:9 first window.
- `--windows` adds `<title>.exe`, named the same way, with the other
  characters Windows refuses in a file name (`\ * ? " < > |`) also
  written as `-`. It keeps readers' progress under the `storyId` too, so
  it needs one as well. It bakes in the same first-window size as the
  Mac app, and prints it.
- Building again replaces the app or exe the build made before, and a
  failed build leaves the folder as it was. After a title change the
  build names the app or exe left under the old title; delete it
  yourself.
- `--icon IMAGE` names the icon picture for both: a PNG, JPEG, WebP, GIF
  or JPEG XL file, cut to the largest square in its middle. Without it
  the icon is the game's first graphic: the first item with a picture,
  which is an image, an animation's first frame or a video's poster. A
  picture that cannot be read stops the build and names the file.
- With neither `--mac` nor `--windows`, `build_apps.py` prints its usage
  and builds nothing. Asked for both, it checks everything both need
  before it builds either. `assemble_folder.py` checks the `storyId`,
  the tools and the icon before it copies anything.

Building the Mac app needs a Mac with a Swift toolchain: Xcode, or the
Command Line Tools (`xcode-select --install`). On any other system, or
without the toolchain, `--mac` stops with one error saying so and writes
nothing. No Apple ID or certificate is needed, since the app is signed
ad hoc.

Building the Windows program needs Go 1.27 or later
(https://go.dev/dl/), on macOS, Linux or Windows: Go builds the Windows
program on any of them, with nothing else installed, since the program
uses Go's standard library alone. Without `go` on
PATH, or with an older one, `--windows` stops with one error saying so
and writes nothing. The build downloads nothing and keeps Go's caches in
`.tmp/windows-app-build/`.

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
- Progress is kept per app, under its bundle id (so a rebuild keeps it)
  and apart from any browser's. A reader who played `index.html` in a
  browser starts over in the app, or moves the progress across with
  Export and Import.
- The first time the app opens from Documents, Desktop or Downloads,
  macOS asks once whether it may use that folder. A rebuilt app asks
  again, because its ad-hoc signature changes with every build.
- A folder downloaded as a zip carries macOS's quarantine flag, and the
  app will not open there: macOS refuses it, or runs it away from its
  folder, where it finds no game and says so. Readers of a download open
  `index.html` instead, or clear the flag first with
  `xattr -dr com.apple.quarantine <folder>`. A folder you build or copy
  on your own Mac has no flag, so its app opens with no check.
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
- Progress is kept in a folder only this game uses,
  `%LOCALAPPDATA%\Kinetic\WebView2\<storyId>`, apart from the reader's
  browsers and any browser that played `index.html` (Export and Import
  move progress across). A rebuild keeps it. The window's mode and place
  are kept in that folder too (`kinetic-window.json`), with a log of the
  exe's last run (`kinetic-host.log`) to ask for when a reader reports a
  problem.
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

Keep each app inside its game folder. Upgrading the player (copying
`index.html` and `app.js`, Upgrading to a newer Kinetic) needs no
rebuild, since each app plays whichever `index.html` sits beside it.

## Testing your game

A script can play a built game folder with no window on screen, to
check after each change that the game still plays as you expect. It
opens the folder's own `index.html` and `app.js`, so it tests exactly
what readers get. It presses the reader's keys and reads what the screen
shows: the manifest item, its line and speaker, and any open choice.

Two engines run it:

- `webkit` is the Mac's own WebKit, set up the way the macOS app sets
  up its web view. It stands for the macOS app and for Safari readers.
  It needs macOS with Xcode or the Command Line Tools
  (`xcode-select --install`). The first open builds a small helper
  program into this repo's `.tmp/`, which takes a few seconds.
- `chrome` is Google Chrome, headless. It stands for Chrome readers and
  for the Windows app, whose WebView2 is Microsoft Edge's engine
  (Chrome's).
  It needs Chrome installed. `KINETIC_CHROME=<program>` names another
  Chrome, Chromium or Edge.

`auto`, the default, takes WebKit on a Mac that can build the helper,
otherwise Chrome, and prints which. Test on both before a release.

Nothing appears on screen with either engine, and neither takes the
focus. Chrome runs headless. The WebKit helper is a background program
with no Dock icon whose one window sits off every screen; it quits
rather than show that window.

### Setting up the tests

Once per checkout of this repo, install the player's packages and build
the player:

```sh
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
```

Tests open an assembled game folder (Playing the folder).

### The quick check

```sh
node player/scripts/testing/check-game.mjs novel-play --steps 30
```

It opens the folder, presses Space 30 times (10 without `--steps`), and
prints each item it reaches. At a choice, Space takes the highlighted
route, as it does for a reader with Play all routes on. Then it prints
any console or page errors, and exits with status 1 if there were any
or the game did not open. `--engine webkit` or `--engine chrome` picks
the engine. On the demo it starts:

```text
webkit: /Users/you/demo-play
  0: intro-title "Kinetic demo. Every line explains what you are seeing. Sp..."
  1: text-speech "Spoken dialogue: the speaker's name, Mei, sits above it."
  2: text-thought "A thought: unspoken, so it is drawn differently from speech."
```

### A test script

Write your test anywhere, as a Node script that imports
`player/scripts/testing/kinetic.mjs` from this repo by its absolute
path. This one tests the demo; assemble it with
`.venv/bin/python tools/assemble_folder.py fixtures/demo demo-play`, and
put your own game's ids and lines in place of the demo's:

```js
// test-demo.mjs: node test-demo.mjs <game-folder> [webkit|chrome]
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { openGame } from "/path/to/kinetic/player/scripts/testing/kinetic.mjs";

const [folder, engine = "auto"] = process.argv.slice(2);
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
assert.deepEqual(game.errors(), []);
await game.close();

// Open again with the same profile: the game resumes on the same item.
const again = await openGame(folder, { engine, profile });
assert.equal((await again.current()).id, "route2-start");
assert.deepEqual(again.errors(), []);
await again.close();
console.log(`${game.engine}: ok`);
```

`node test-demo.mjs demo-play webkit` and `node test-demo.mjs demo-play
chrome` each print `ok`. A failed check stops the script with an error
naming what was on screen.

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
- `log`: a function given openGame's note of the engine `auto` chose
  (printed to stderr by default), or `null` for none.

The game:

- `current()` resolves with what the screen shows: `{ id, index, text,
  speaker, file, choice, screen, ambiguous }`.
  - `id` and `index` name the manifest item, or are `null` and -1 on a
    screen no item makes.
  - `text` and `speaker` are the line on screen (`null` when none).
  - `file` is the picture or video on screen.
  - `choice` is `null`, or `{ prompt, rows }` while a choice is open.
    Each row is `{ number, label, seen, next, continue }`: `next` marks
    the route Space takes, `continue` the "Return to main route" row.
  - `screen` is `"esc"` or `"map"` while one is over the story.
  - The item is found from the line and picture on screen. When two
    items look the same (a repeated line over the same picture), the
    player's saved place decides. If even that cannot, `ambiguous`
    lists the candidates and `id` is the nearest one ahead.
- `press(key, { times })` presses a key by name: `Space`, `Tab`,
  `Escape`, `Enter`, a letter, a digit, `ArrowUp`, `ArrowDown`,
  `ArrowLeft`, `ArrowRight`, `PageUp`, `PageDown`, `Home`, `End`,
  `Delete` or `Backspace`.
- `spaceUntil(target, { limit })` presses Space until `target`: an item
  id, or a function given `current()` that returns true. It stops with
  an error at a choice while Play all routes is off, when Space changes
  nothing five times running, or after `limit` presses (100 by
  default).
- `waitForItem(target, { timeout })` and `waitForChoice({ timeout })`
  wait without pressing anything (10 s by default), for timed play such
  as auto-forward (`a`).
- `pickRoute(n)` picks row `n` of the open choice with its digit key (1
  to 9, or 0 for "Return to main route") and resolves with the route's
  first screen. Rows past 9 take `press("ArrowDown")` and
  `press("Enter")`.
- `reload()` reloads the page, as a reader's reload does.
- `screenshot(path)` saves a PNG of the page, making its folders.
- `errors()` lists the console errors and warnings and the page errors
  so far, including a picture, video or script that failed to load (on
  WebKit the library reports these itself, since WebKit does not). A
  load still under way reports a moment later.
- `close()` closes the game; every open needs one.
- `page` is the puppeteer page for anything else (`page.evaluate`,
  `page.mouse.click(x, y)`). In WebKit it offers the subset the player's
  own test suite uses.
- `engine`, `folder` and `manifest` say what was opened.

## Upgrading to a newer Kinetic

A game folder's player is two files, `index.html` and `app.js`; every
other file (`manifest.json`, `manifest.js`, media, extras) is your
content. To take a newer player's bug fixes, replace just those two:

```sh
git pull
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
cp player/dist/index.html player/dist/app.js my-novel/
.venv/bin/python tools/validate_content.py my-novel
```

Copy only those two files: `player/dist/manifest.js` is an empty
placeholder that would overwrite your game's own `manifest.js` (the
validator then reports that it does not equal `manifest.json`), and
`app.js.map` is a debugging aid the folder does not need. `manifest.js`
stays as it is, since it is generated from your `manifest.json`, not
from the player; regenerate it only when you edit `manifest.json`
(Generating manifest.js). The validator checks the folder against
the newer rules; a clean run prints nothing. An app in the folder
(Building the apps) keeps working without a rebuild.

Readers keep their progress. The player saves it in each reader's
browser under the manifest's `storyId`, not inside the folder, so the
new player picks it up on the next open. A manifest without a `storyId`
keys progress by the folder's location instead; add one (see Manifest)
and the first open carries that progress over to it.

Re-extract instead when the fix is in the converter (`kinetic-extract`)
rather than the player, or when the validator rejects a folder the
older Kinetic accepted, such as a manifest whose `schemaVersion` the
newer tools no longer take. Run `.venv/bin/python
tools/setup_media_tools.py` first (the pull may have changed the pinned
tools), then extract into a new folder with the same `storyId` (the
extractor derives the same one from the same project; otherwise pass
`--story-id`, and for episodes keep their order), copy the player in,
validate, and replace the old folder. A folder converted with other
pinned tools rebuilds only with the Kinetic commit that made it
(Checking a folder with rebuild). Progress is saved by item id, so items that keep their
ids keep their seen marks and the reading position; ids that no longer
exist drop out of it. A hand-authored folder follows
docs/content-format.md for the new `schemaVersion` instead.
