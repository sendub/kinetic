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
- `type`: `image`, `animation`, or `video`.
- `speaker`: optional name drawn above the text.
- `text`: optional line drawn below the speaker. Empty or absent `text`
  means a bare visual: nothing is drawn and `speaker` is ignored.

Per type:

- `image` with `file`: one display-resolution image.
- `animation` with `frames` (ordered display-resolution frames, at least
  two), `fps` (frames per second, greater than 0), and `loopCount` (how
  many times the sequence plays before auto-advance, at least 1).
- `video` with `file` (H.264 faststart MP4), `poster` (still image shown
  for instant first paint), and `durationSeconds` (runtime of the encoded
  video, greater than 0), so skip-mode timing needs no media probing.

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
    }
  ]
}
```

## Timing

The manifest describes content; pacing belongs to the player. Reading speed,
skip dwell, and skip-all live in the player's settings (IndexedDB), never in
the manifest. The format defines how the player derives per-item timing from
content:

- Text hold time, in seconds, is
  `max(minHold, chars(text) * msPerChar / readingSpeed) / 1000`, where
  `chars` counts Unicode code points excluding the speaker, `readingSpeed`
  is the player setting (default 1.0), and the defaults are `minHold = 1.5`
  and `msPerChar = 60`. An item with no text holds for `minHold`.
- An image auto-advances when its text hold time elapses.
- An animation's loop time is `len(frames) * loopCount / fps`. Auto-advance
  fires at the later of loop time and text hold time, so the loops complete
  before the item advances on its own.
- A video plays through once. Auto-advance fires at the later of the `ended`
  event and the text hold time.
- Skip mode shows each item for a fixed player dwell. An animation
  contributes `frames[0]` and a video its `poster`; both show that still and
  never play. A video holds for `min(dwell, durationSeconds)`.
- Rewind shows `frames[0]` and the poster too.

## Naming conventions

The converter writes each generated file at the folder root, named after the
owning item id. Since ids contain no dots, suffixes parse unambiguously:

- `<id>.jpg`: the display-resolution image of an image item, referenced by
  `file`.
- `<id>.fNNN.jpg`: animation frame N, zero-based and zero-padded to three
  digits, referenced in `frames`.
- `<id>.poster.jpg`: the video's first frame, extracted at conversion and
  referenced by `poster`. The poster doubles as the first frame shown in
  skip mode and rewind.
- `<id>.thumb.jpg`: a preview no wider than 320 pixels, derived from the
  item's first visual (image, frame 0, or poster). Bookmarks capture the
  visible surface at run time; the thumbnail is the fallback when no surface
  can be captured, such as a video with no decoded frame.

The manifest stays authoritative: the player reads exactly the files the
manifest references, never a directory scan.

## Rules and validator invariants

Format rules:

- Paths are relative to the content folder. The schema pattern enforces the
  character set: no leading `/`, no drive letters or scheme, no `..`, no
  spaces.
- Images carry the extension `.png`, `.jpg`, `.jpeg`, or `.webp`; videos
  `.mp4`. The schema pins these per field.
- Every media value matches the path pattern.

The validator checks the schema plus these filesystem invariants:

1. `manifest.json` validates against `docs/content-schema.json`.
2. Every path in the manifest resolves to an existing file in the folder.
3. Item ids are unique.
4. `schemaVersion` is 1; `items` is non-empty; `frames` has at least two
   entries; `loopCount` is at least 1; `fps` and `durationSeconds` are
   greater than 0; `width` and `height` are at least 1. The schema enforces
   all of these.
5. When `manifest.js` is present, the embedded JSON parses equal to
   `manifest.json`.
