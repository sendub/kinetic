# Kinetic Content Format

The directory format the Python converter writes and the TypeScript player
reads. It is the only artifact the two share; everything else is private to
each side. A content folder is self-contained: with the player bundle copied
in, double-clicking `index.html` plays the novel offline.

The machine-readable definition is `docs/content-schema.json`. This document
states the semantics the schema cannot express.

## Folder layout

```text
my-novel/
  index.html      # player shell, copied in at packaging time
  app.js          # player bundle, same copy step
  manifest.json   # source of truth for tools and validation
  manifest.js     # generated shim: window.KINETIC_MANIFEST = {...}
  *.jpg, *.mp4    # media files, named per the conventions below
```

- Every file the novel needs lives inside the folder. There are no absolute
  paths, no external URLs, and no network access at play time.
- `manifest.json` is the source of truth. Tools and the validator read it.
- `manifest.js` is generated from `manifest.json` and contains exactly
  `window.KINETIC_MANIFEST = <manifest JSON>;`. The player loads it as a
  classic script, so the folder works over `file://` without fetch. Both
  files encode the same JSON; the validator checks this.
- Media paths in the manifest are relative to the manifest's own directory,
  use POSIX separators, and contain no `..` segments.
- The player bundle copy is the last packaging step (docs/plan.md Phase 12).
  A content folder without it is still valid input for tools.

## Manifest

```jsonc
{
  "schemaVersion": 1,
  "width": 1920,
  "height": 1080,
  "items": []
}
```

- `schemaVersion`: integer, currently 1. Tools reject any other value.
- `width`, `height`: display resolution in pixels. Every generated image is
  exactly this size, and the player scales its surface to the screen.
- `items`: the ordered sequence. Position in the array is position in the
  novel; the player's cursor, frontier, bookmarks, and jumps all refer to
  these indexes.

## Items

Every item carries `id`, `type`, and optional overlay fields:

- `id`: unique ASCII slug matching `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, used
  for stable reference by tools (validator reports, converter logs). It
  contains no dot, so derived filenames parse unambiguously. Array position
  remains the only ordering the player reads.
- `type`: `image`, `animation`, `video`, or `text`.
- `speaker`: optional name drawn above the text.
- `text`: optional line drawn below the speaker. Empty or absent `text`
  means a bare visual: nothing is drawn and `speaker` is ignored.
- `thought`: optional boolean, default `false`, on every item type
  above, since all four can carry text. `thought: true` marks `text`
  as `speaker`'s unspoken thought rather than spoken dialogue, so the
  overlay draws the two differently. Without a non-empty `text` a
  `thought` is meaningless, and the validator rejects it.

Per type:

- `image` with `file`: one display-resolution image, as `.png`, `.jpg`,
  `.jpeg`, `.webp`, `.gif`, or `.jxl`. JXL decode needs Chrome/Edge
  117+, Safari 17+, or Firefox 133+; the converter ships `.jxl` only
  after probing an encoder and confirming the encode is smaller than
  the compatible original, else it keeps the compatible original.
- `animation` with `frames` (ordered display-resolution frames, at least
  two), `fps` (frames per second, greater than 0), and `loopCount` (how
  many times the sequence plays before auto-advance, at least 1).
- `video` with `file` (any browser-playable video file: `.mp4`,
  `.webm`, `.mkv` (VP9/AV1), `.mov`, and `.m4v` are allowed, and
  playability is the browser's call), `poster` (still image shown
  for instant first paint), and the required `durationSeconds`
  (runtime of the encoded video, greater than 0; the converter fills
  it via ffprobe, and skip-mode timing needs it). Optional
  `loopCount` (integer, at least 1, default 1) plays the video
  repeatedly; optional `holdSeconds` (number greater than 0) sets an
  explicit display duration. MKV is reliably Chromium-class and Safari
  may refuse it, so a converter targeting Safari should emit MP4 and
  record the choice in the build ledger.
- `text` takes no media fields. `id` and `type` are required, `speaker`,
  `text`, and `thought` are optional, and no other fields are accepted.
  On a `text` item `thought` behaves as elsewhere: a thought line in a
  dialogue chain. See Text items below.

Example:

```jsonc
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
      "id": "rain-002", "type": "animation", "fps": 12, "loopCount": 3,
      "frames": ["rain-002.f000.jpg", "rain-002.f001.jpg",
                 "rain-002.f002.jpg"],
      "text": "Rain began against the window."
    },
    {
      "id": "intro-003", "type": "video", "file": "intro-003.mp4",
      "poster": "intro-003.poster.jpg", "durationSeconds": 18.4
    },
    // intro-003 loops under both text items
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

### Text items

A `text` item adds dialogue over a visual already on screen, so several
lines can advance over one continuous looping video or animation. It
shows the visual of the nearest earlier item that bears media: an image
file, an animation, or a video. That visual keeps playing while the
current item is `text` or the next item is `text`: a video loops, an
animation keeps looping, and an advance within such a chain is never
gated on media end. Rewind, skip, and `e`-jump to a `text` item show
that visual as a still: a video's `poster` or an animation's
`frames[0]`. The first item may not be `text`, and a `text` item only
makes sense after some media-bearing item.

## Timing

The manifest describes content; pacing belongs to the player. Reading speed,
skip dwell, and skip-all live in the player's settings (IndexedDB), never in
the manifest. The format defines how the player derives per-item timing from
content:

- Text hold time, in milliseconds, is `textHoldMs = max(minHoldMs,
  codepoints(text) * msPerChar / readingSpeed)`. `codepoints` counts
  Unicode code points, excluding the speaker; `readingSpeed` is the
  player setting (default 1.0); `minHoldMs` and `msPerChar` are
  millisecond-denominated player settings whose defaults are
  `minHoldMs = 1500` and `msPerChar = 60`. An item with no `text`
  holds for `minHoldMs`.
- `thought` changes no timing: a thought line holds exactly as the
  same `text` would as dialogue.
- An image auto-advances when its text hold time elapses. A `text`
  item holds for its text hold time and nothing else.
- An animation's loop time, in milliseconds, is `len(frames) *
  loopCount * 1000 / fps`. Auto-advance fires at the later of loop
  time and text hold time, so the loops complete before the item
  advances on its own.
- A video's media gate is `holdSeconds` when present: the hold is
  time driven only, `ended` is ignored, and the video plays as
  background. Otherwise auto-advance fires at the later of the
  `loopCount`-th `ended` event and `durationSeconds * loopCount` as
  a time bound. The text hold always applies alongside the gate.
- A media item followed by `text` items, and the `text` items after
  it, form a chain. The chain advances on text hold times alone. Loop
  completion and the `ended` event gate nothing while it lasts, and
  the chain's visual plays throughout it, looping in place.
- Skip mode shows each item for a fixed player dwell. An animation
  contributes `frames[0]` and a video its `poster`; both show that
  still and never play. A video holds for `min(skipDwell,
  (holdSeconds ?? durationSeconds * loopCount))`.
- Rewind shows `frames[0]` and the poster too. Rewind, skip, and
  `e`-jump show a `text` item as the still of the visual it displays.

## Naming conventions

The converter writes each generated file at the folder root, named after the
owning item id. Since ids contain no dots, suffixes parse unambiguously:

- `<id>.<ext>`: the item's own media file, referenced by `file`: the
  display-resolution image of an image item, or the video of a video
  item. `ext` is the true shipped format, `jpg`, `png`, `webp`,
  `jxl`, or `gif` for images and `mp4`, `webm`, `mkv`, `mov`, or
  `m4v` for video. Browser-compatible originals are preserved
  byte-identical, with no forced re-encode.
- `<id>.fNNN.jpg`: animation frame N, zero-based and zero-padded to three
  digits, referenced in `frames`.
- `<id>.poster.jpg`: the video's first frame, extracted at conversion and
  referenced by `poster`. The poster doubles as the first frame shown in
  skip mode and rewind.
- `<id>.thumb.jpg`: a preview no wider than 320 pixels, derived from the
  item's first visual (image, frame 0, or poster). Bookmarks capture the
  visible surface at run time; the thumbnail is the fallback when no surface
  can be captured, such as a video with no decoded frame.

These names describe the files the converter generates. They are
defaults, not a one-file-per-item rule. Multiple items may reference
the same derivative file, the converter dedups identical sources, and a
hand-authored folder may name its files differently.

The manifest stays authoritative: the player reads exactly the files
the manifest references, never a directory scan. A folder may carry
extra unreferenced files, such as the converter's build ledger; the
player and the validator ignore them.

## Rules and validator invariants

Format rules:

- Paths are relative to the content folder. The schema pattern enforces the
  character set: no leading `/`, no drive letters or scheme, no `..`, no
  spaces.
- Images carry the extension `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`,
  or `.jxl`; videos `.mp4`, `.webm`, `.mkv`, `.mov`, or `.m4v`. The
  schema pins these per field.
- Every media value matches the path pattern.

The validator checks the schema plus these invariants:

1. `manifest.json` validates against `docs/content-schema.json`.
2. Every path in the manifest resolves to an existing file in the folder.
3. Item ids are unique.
4. `schemaVersion` is 1; `items` is non-empty; `frames` has at least two
   entries; `loopCount` is at least 1; `fps` and `durationSeconds` are
   greater than 0; `width` and `height` are at least 1. The schema enforces
   all of these.
5. When `manifest.js` is present, the embedded JSON parses equal to
   `manifest.json`.
6. An item sets `thought` true only when its `text` is non-empty. The
   schema cannot express this cross-field rule, so the validator reports
   it.
