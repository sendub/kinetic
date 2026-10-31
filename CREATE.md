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
```

`index.html` and `app.js` are the player bundle, copied in as the last
step before playing (see "Playing the folder"). A content folder without
them is still valid input for the validator.

### Manifest

`manifest.json` carries `schemaVersion` (1), the display `width` and
`height` in pixels, and `items` in play order. Each item has a unique
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
  required either way.
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
These names are the defaults the converter generates, not a
one-file-per-item rule.
Several items may reference the same derivative file, the converter
dedups identical sources, and you may name hand-authored files
differently. A folder may also carry extra unreferenced files, such as
the converter's build ledger; the player and the validator ignore them.

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

## Converting a Ren'Py project (planned, Phase 10)

The extractor is not built yet. Per docs/plan.md Phase 10 it will turn a
Ren'Py project directory into exactly this folder format:

```sh
python -m kinetic_extract <renpy_project> <out_dir>
```

It will sniff true formats and keep browser-compatible originals
byte-identical, re-encoding only what it must: images become lossless
JPEG XL when that is smaller, video becomes H.264 MP4 when no target
browser plays it. It emits posters and thumbnails, which is the work
you do by hand above, dedups identical sources into shared derivative
files, and leaves its build ledger among the folder's unreferenced
extras. Validate and play its output the same way.

## Playing the folder

Copy the built player bundle from this repo into the content folder:

```sh
cp player/dist/index.html player/dist/app.js my-novel/
```

Run `npm run build` in `player/` first if the bundle is not current. The
bundle in `player/dist` is the current build; the behavior described
here lands in the later phases of docs/plan.md.

Double-click `index.html` to open the novel in your default browser.
The first keypress or click puts the player in fullscreen, so that first
keypress can simply be space, the advance key.

Controls, from README.md:

- `space`: advance one item.
- `tab`: skip at a rapid fixed speed, showing only the first frame of
  animations and videos; never past unseen content unless a skip-all
  config option is enabled.
- `h`: hide or show the overlay text.
- `b`: bookmark the current moment as a timestamped thumbnail.
- `t`: open the bookmark list; click a thumbnail to resume there.
- `e`: jump to the item just before the next unseen one.
- `c`: open the config screen (reading speed, skip-all).
- scroll wheel: roll back through seen items; roll the other way to
  return, never to unseen content.

With no input the player auto-advances at the configured reading speed:
images hold for their text, animations complete their loops, and videos
play through once. A media item followed by `text` items holds for its
text alone while its animation or video loops underneath, and each
`text` item holds for the length of its text.
