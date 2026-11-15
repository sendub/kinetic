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
  *.m4a, *.mp3     # sound, if the game has any (Sound, below)
  *.m4a.js         # beside each sound file, its bytes as a script
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
`result: "ending"`, so its last item IS that route's ending. To set a
scene change, author a `text`-only item or title image at a route's
start or end — the format needs no transition field. The validator
accepts this manifest; `tools/data/branches-example` carries exactly
this folder.

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
file"). `tools/assemble_folder.py` writes every missing one when it
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
its WebM tracks 2-8 ms over. `kinetic-media ship` with `"kind": "audio"`
requests measures it by decoding, copies Ogg into WebM, ships a request
with `"loops": true` in a loop-safe format and writes the scripts for
you (Writing your own converter: kinetic-media ship, below).
`fixtures/audio-demo`, built by `.venv/bin/python
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
video's playback range fits inside its `durationSeconds`, every track an
item names exists, each sound file has its script holding its bytes (or
ships as that script alone, as an assembled folder does), and a present
`manifest.js` embeds JSON equal to `manifest.json`. An Ogg track, a
looping track in MP3 or Opus in WebM, and a track no item uses each
print a `warning:` line on stderr, which leaves the exit status alone.

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
It also ships the sound the scripts play (music, ambience loops,
one-shots and voice lines) and each video's audible soundtrack.
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
setup_media_tools: self-test passed (22 cases)
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
   fails, below). Two lines count the sound, here for
   fixtures/renpy_demo:

   ```text
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
request ships a sound file for a track by kinetic-extract's rule: MP3,
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
(Sound, above), generates `manifest.js` (Generating manifest.js), and the
folder is validated, played and rebuilt like any other:

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

Rebuild the converter's folder, not the copy `tools/assemble_folder.py`
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
PYTHONPATH=~/games/rainy-kinetic .venv/bin/kinetic-media posters \
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
it. A remuxed video has no audio track, since the player plays videos
muted: the video's own sound ships separately as an audio track, its
item's `videoSound`, which kinetic-extract requests for every video
(Converting, checking and playing one game, above).

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
| `script mismatch: ...` | On a sound file's `.js`: the file rebuilt right, but the script made from it is not the one the ledger records, so the ledger was edited or another Kinetic wrote it; rebuild with the commit that made the folder. |
| `not in the ledger` | A file in `media/` no ledger lists, often left by converting into a non-empty folder; convert into an empty folder. |
| `absent from the folder` or `folder file differs from the ledger: …` | The folder's `media/` lost or altered a file. Copy the folder again, or rebuild with `--out DIR` (a new folder) and copy `DIR/media/.` over the folder's `media/`. Every sound file is absent from an assembled copy: rebuild the converter's folder instead. |
| `…: existing file's sha256 is …, not the one its name gives; not replaced …` | With `--out DIR`, a file already in `DIR` under that content name holds other bytes; it is never overwritten. Delete it, or rebuild into a new `DIR`. |

Reference: docs/extracting.md, "kinetic-media rebuild".

## Playing the folder

Copy the built player bundle from this repo into the content folder:

```sh
cp player/dist/index.html player/dist/app.js my-novel/
```

Or let `tools/assemble_folder.py <content-dir> <out-folder>` assemble a
playable copy in one command: it copies the bundle and content, generates
a missing `manifest.js` and the missing script of each sound file (Sound,
above), ships the scripts without the sound files, and prints the folder
size (docs/packaging.md).

Run `npm run build` in `player/` first if the bundle is not current.

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

The controls are listed in README.md ("Playing").

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
- A game with sound plays it from launch, with no key or click first and
  no "Press any key for sound" hint.
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
rather than show that window. `openGame` and check-game make no sound
either: the library tells the player to hold its output at zero on every
page, Chrome plays to no audio device and the WebKit helper mutes its
page, while the game's sound still plays and `current().audio` reports it.

### Setting up the tests

Once per checkout of this repo, install the player's packages and build
the player:

```sh
cd player && npm ci --cache ../.tmp/npm-cache && npm run build && cd ..
```

Tests open an assembled game folder (Playing the folder).

### The quick check

```sh
node player/scripts/testing/check-game.mjs novel-play --steps all
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
webkit: /Users/you/demo-play
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
media: 26 files: 1 loaded during the walk, 25 checked after it (3 never requested)
no console or page errors
```

The exit status says how it went:

| Status | Meaning |
| --- | --- |
| 0 | Passed. |
| 1 | Console or page errors (a file that failed to load or decode, a symbolic link out of the folder), a game that would not open (a player too old for `--start-at` among them), a stuck player, the `--steps all` limit, an `--until` item not reached, or a media check that stalled or failed. |
| 2 | Bad arguments: an unknown option, an `--engine` other than `webkit`, `chrome` or `auto`, a `--steps` that is neither a number nor `all`, or an id the manifest does not have (checked before anything opens). |
| 3 | A walk from the opening reached the story's end with items never shown, or a walk reached its `--until` item with items of its span not shown. |

1 wins over 3: a walk with errors and items never shown exits 1.

#### Checking part of a game

To check content late in a long game without walking everything before
it, start at the first item of the scene, and stop where it ends or
after a number of steps (`--steps N`):

```sh
node player/scripts/testing/check-game.mjs demo-play --start-at route1-start --until after-start
```

```text
webkit: /Users/you/demo-play
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
node player/scripts/testing/check-game.mjs demo-gap --start-at branch-title --until after-start
```

```text
stopped after 14 steps: reached after-start (--until)
visited 11 of 33 items
span: 11 of 12 items shown from branch-title to after-start
not shown in the span: aside-unreached
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
node player/scripts/testing/check-game.mjs demo-segments --start-at floor-clip --steps 6
```

```text
webkit: /Users/you/demo-segments
  0: floor-clip "Short line one."
  1: floor-2 "Short line two."
  2: floor-3 "Line three waits."
  3: floor-3 "Line three waits." view 2 of 3
  4: floor-3 "Line three waits." view 3 of 3
  5: branch-title "Next: a decision. Route 1 continues the story and holds a..."
  6: branch-lead "Shared lead-in: every route starts after this. The decisi..."
stopped after 6 steps
visited 5 of 32 items
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

`node test-demo.mjs demo-play webkit` and `node test-demo.mjs demo-play
chrome` each print `ok`. A failed check stops the script with an error
naming what was on screen. Await `checkMedia()` before reading
`errors()` after any walk: a walk faster than a reader moves past
pictures and videos before they finish loading, and a load cut short
reports no error, so a broken file would otherwise pass.

### Checking the sound

`current()` reports the game's sound as `audio` (What the library
offers, below), so a test can check what plays at each item with no
window and nothing heard: both engines play the sound, and the library
tells the player to hold its output at zero on every page it opens, on top
of Chrome's missing audio device and the WebKit helper's mute. This one
checks the audio demo's first music; assemble it with
`.venv/bin/python tools/assemble_folder.py fixtures/audio-demo
audio-demo-play`:

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
- `mediaChecks`: `false` loads no media file off the page to check it,
  as check-game's `--no-media-check` does: `errors()` then lists only
  the failed loads the page's own elements report, and `checkMedia()`
  throws. `true` by default.
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

A game with sound made before audio scripts existed fails the validator
once per sound file, with `no script '<file>.js' beside it`. Write the
scripts as Sound, above, says (`tools/assemble_folder.py` writes every
missing one), or ship the sound again: kinetic-extract, and kinetic-media
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
`check-game.mjs --steps all` (The quick check) instead. A script that
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
