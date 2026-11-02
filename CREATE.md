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
folder, and a progress file a reader exports from the `c` screen imports
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
- `video`: `file` (any browser-playable file; `.mp4`, `.webm`,
  `.mkv`, `.mov`, and `.m4v` are allowed, and playability is the
  browser's call), `poster` (a display-resolution still, the frame
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
`jxl`, or `gif` for images; `mp4`, `webm`, `mkv`, `mov`, or `m4v` for
video), `<id>.fNNN.jpg` for animation frames numbered from `f000`,
and `<id>.poster.jpg` for a video poster. Browser-compatible
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
`continuingRoute` and proceeds to `continueAt`; every other route
must be an `ending` (the default: its last item IS the ending) or
declare `result: "return"`. There is no implicit join. Two different
milestones decide what a re-opened decision shows: a route row's seen
mark needs only ENTERING that route, while the "Return to main route"
row appears only once the reader has played the `continuingRoute`
through to its end at least once - a route entered and abandoned opens
nothing, and until the continuing route is finished, re-openings offer
routes only. Readers do not have to answer: "Play all routes" is on by
default, so each choice counts down and the player plays every route,
shortest first, then `continueAt`; a reader who turns it off in `c`
picks routes themselves. Full semantics
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

The extractor turns a Ren'Py project directory (loose dir, `.app`
bundle, or slice with `--label/--max-items/--files`) into exactly this
folder format:

```sh
.venv/bin/pip install -r requirements.txt   # once per venv
.venv/bin/pip install -e ./converter        # once per venv
.venv/bin/python tools/setup_media_tools.py # once per checkout
.venv/bin/kinetic-extract <renpy_project> <out_dir>
```

The setup script downloads the pinned static ffmpeg and ffprobe for your
OS and architecture into `.media-tools/` (checksum-verified) and checks
that every media tool gives byte-identical results on a set of samples.
The extractor uses only those tools, never whatever ffmpeg is on your
PATH, so the same game converts to the same bytes on any machine; it
refuses to run until the setup has passed (converter/README.md, "Pinned
media tools").

It sniffs true formats and keeps browser-compatible originals
byte-identical, re-encoding only what it must: images become lossless
JPEG XL when that is smaller, video becomes H.264 MP4 when no target
browser plays it. It emits posters, which is the work
you do by hand above, stores identical output once, decompiles `.rpyc` (vendored unrpyc) and reads `.rpa` archives as
sources, converts simple `menu:` blocks into branches (conservatively;
never guessing joins), and leaves its build ledger among the folder's
unreferenced extras. Every media file it ships, posters included, is
named by the sha256 of its bytes, `media/<h[:2]>/<h>.<ext>`, so the same
game gives the same paths on any machine and a big game never puts
thousands of files in one folder that macOS Finder has to lay out
(docs/extracting.md, "Output layout"). Validate and play its output the same way.

If a game wraps or obfuscates its images or videos in its own way, pass
a decoder for it: `--decoder path/to/unwrap.py:decode`, a Python function
that gets each media file's bytes and returns them unwrapped (or `None`
to leave them alone). Kinetic ships no game-specific decoders; see
docs/extracting.md, "Decoder hooks".

The extractor names the game and the story for you: the `title` is the
project's `config.name` (else its folder name, with `_` and `-` read as
spaces), and the `storyId` is derived from `config.save_directory`,
`config.name` or the folder name. Set either yourself with
`--title "Rainy Day"` and `--story-id rainy-day-1` (the id must already
be a valid `storyId`), or edit `manifest.json` afterwards and regenerate
`manifest.js` (Generating manifest.js).

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
The first keypress or click puts the player in fullscreen, so that first
keypress can simply be space, the advance key.

The controls are listed in README.md ("Playing").

In auto mode (`a`) the player advances at the configured auto-forward
speed ("Auto-forward speed" in the `c` settings):
images hold for their text, animations complete their loops, and videos
play through once. A media item followed by `text` items holds for its
text alone while its animation or video loops underneath, and each
`text` item holds for the length of its text.

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
the newer rules; a clean run prints nothing.

Readers keep their progress. The player saves it in each reader's
browser under the manifest's `storyId`, not inside the folder, so the
new player picks it up on the next open. A manifest without a `storyId`
keys progress by the folder's location instead; add one (see Manifest)
and the first open carries that progress over to it.

Re-extract instead when the fix is in the converter (`kinetic-extract`)
rather than the player, or when the validator rejects a folder the
older Kinetic accepted, such as a manifest whose `schemaVersion` the
newer tools no longer take. Extract into a new folder with the same
`storyId` (the extractor derives the same one from the same project;
otherwise pass `--story-id`), copy the player in, validate, and replace
the old folder. Progress is saved by item id, so items that keep their
ids keep their seen marks and the reading position; ids that no longer
exist drop out of it. A hand-authored folder follows
docs/content-format.md for the new `schemaVersion` instead.
