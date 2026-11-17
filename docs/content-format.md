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
  manifest.schema.json  # kinetic-extract's copy of the schema, for
                  # editors; an assembled folder leaves it out
  media/ab/…      # converter output: media/<h[:2]>/<h>.<ext>
  *.jpg, *.mp4    # or any other legal layout, e.g. flat (hand-authored)
  *.m4a.js        # beside each audio file, its bytes as a script; an
                  # assembled folder ships the script alone (Audio)
  lang/de.json    # a language file per translation (Translations)
  lang/de.js      # generated: window.KINETIC_LANGUAGES["de"] = {...};
```

- Every file the novel needs lives inside the folder. There are no absolute
  paths, no external URLs, and no network access at play time.
- `manifest.json` is the source of truth. Tools and the validator read it.
- `manifest.js` is generated from `manifest.json` and contains exactly
  `window.KINETIC_MANIFEST = <manifest JSON>;`. The player loads it as a
  classic script, so the folder works over `file://` without fetch. Both
  files encode the same JSON; the validator checks this.
- Media paths in the manifest are relative to the manifest's own directory,
  use POSIX separators, contain no `..` segments, and may name a subfolder
  of that directory (`media/ab/window-004.jpg`).
- The player bundle copy is the last packaging step (docs/plan.md Phase 12).
  A content folder without it is still valid input for tools.

## Manifest

```jsonc
{
  "$schema": "./manifest.schema.json",
  "schemaVersion": 1,
  "storyId": "the-lantern-at-low-tide",
  "title": "The Lantern at Low Tide",
  "version": "1.2",
  "width": 1920,
  "height": 1080,
  "items": []
}
```

- `$schema` (optional): any string, the address of the JSON Schema an
  editor checks the manifest against. The player and the validator
  ignore its value. kinetic-extract writes
  `"$schema": "./manifest.schema.json"` as the manifest's first key and
  puts `manifest.schema.json`, a byte copy of `docs/content-schema.json`,
  beside `manifest.json`, so VS Code, and other editors that read
  `$schema`, check and complete a hand-edited `manifest.json` offline,
  against the schema of the Kinetic release that wrote the folder.
  `tools/upgrade_folder.py` replaces a folder's copy with the current
  schema; a hand-written folder gets one by copying
  `docs/content-schema.json` in under that name.
  `tools/assemble_folder.py` leaves the copy out of the folder readers get and keeps the key in
  the manifest as written; an editor that finds no file there checks
  nothing.
- `schemaVersion`: integer, currently 1. Tools reject any other value
  (Schema version below).
- `storyId` (optional): the story's stable identity, independent of where
  its folder lives: lowercase ASCII letters, digits, `-` and `_`, starting
  with a letter or digit, at most 64 characters
  (`[a-z0-9][a-z0-9_-]{0,63}`). The player keys the saved reading
  position, settings, help-seen flag and bookmarks by it, so moving,
  renaming or copying the folder keeps progress in that browser. Two
  folders with one `storyId` share progress; keep it the same across
  content updates. Without it (manifests from before it existed) the
  player keys progress by the folder's URL as before; the first load of
  a manifest that has one carries progress saved under that folder's URL
  over to the story. Adding the field did not change `schemaVersion`: it
  is optional, and a reader that ignores it loses nothing but the
  portability. kinetic-extract derives it from the Ren'Py project:
  `config.save_directory` (Ren'Py's own per-game save id, e.g.
  `"GameName-1234567890"`), else `config.name`, else the project folder
  name, slugified (accents folded to ASCII, lowercased, every other run
  of characters one `-`, trimmed of leading/trailing `-`/`_`, cut to 64;
  a name with no ASCII letter or digit becomes `story-` plus 12 hex
  digits of its sha1).
  `kinetic-extract --story-id ID` sets it instead (ID must already match
  the pattern; anything else is a usage error).
- `title` (optional): the game's name as readers see it, plain text with
  at least one non-space character and at most 200 characters. The
  player shows it as a heading at the top of the Esc help screen and as
  the page (browser tab) title; it is set as text, so markup in it shows
  literally. Without it the help screen has no heading and the page
  title stays `Kinetic`. Like `storyId` it is optional, so
  `schemaVersion` did not change. kinetic-extract takes the Ren'Py
  project's `config.name` string literal (`_()` unwrapped, escaped
  quotes undone), else the project folder name (a `game/` input's
  parent, a macOS bundle without `.app`) with each run of `_`, `-` and
  spaces read as one space (`My_Game-1.0` becomes `My Game 1.0`);
  `--title TEXT` sets it instead, and the game maker may edit it in the
  manifest at any time.
- `version` (optional): the game's own release as its author names it
  (`1.2`, `0.9 beta`, `Episode 3`), plain text with at least one
  non-space character and at most 40 characters. It is the game's
  version, not the format's (`schemaVersion`) or Kinetic's. The player
  shows it on the Esc help screen after the `title` heading, smaller
  and dimmer (with no `title`, the version alone where the heading would
  be); it is set as text, so markup in it shows literally. Without it
  nothing is shown. A value that is blank or not text shows nothing,
  as a bad `title` does. Like `title` it is optional, so `schemaVersion`
  did not change. kinetic-extract takes the Ren'Py project's
  `config.version` when it is a string literal (`_()` unwrapped,
  escaped quotes undone, trimmed, cut to 40 characters), such as the
  `define config.version = "1.0"` in Ren'Py's `options.rpy` template;
  anything else (an expression, a variable, `None`, a blank string)
  gives no `version`. `--game-version TEXT` sets it instead (blank or
  longer than 40 characters is a usage error), and the game maker may
  edit it in the manifest at any time.
- `language` (optional): the language the manifest's own text is
  written in, the base every translation is made from, as a language
  tag (Translations): `"en"`, `"ja"`, `"pt-BR"`. Absent means `"en"`.
- `languages` (optional): the tags of the language files in the
  folder, one `lang/<tag>.json` each (Translations), such as
  `["de", "ja", "ar"]`. The player cannot list a folder opened from
  disk, so this list is how it learns which translations exist. Each
  tag appears once and is never the base `language`. Absent or empty:
  the game has only its base language. An older player ignores both
  fields and plays the base, so neither changed `schemaVersion`.
- `width`, `height`: display resolution in pixels. Every generated image is
  exactly this size, and the player scales its surface to the screen.
- `items`: the ordered sequence. Position in the array is position in the
  novel; the player's cursor and jumps refer to these indexes while it
  runs. Saved state never does: the seen set, the reading position, the
  last pick at each decision, bookmarks, and played / completed routes
  are stored by item
  `id`, decision `id` and route `id`, so a content update (items inserted
  before existing ones, a new route, a reorder, an extension) keeps every
  save valid. A saved id the updated manifest no longer has is dropped on
  its own (a deleted item leaves the seen set, and a bookmark on it is
  no longer listed). Keep ids stable across updates.
  The array may be empty: an empty manifest is a valid,
  honestly-empty folder — a converter run in which no visual resolved to
  a file ships no items rather than placeholders — and the player renders
  its no-content state for it.
- `branches`, `audio`, `voices`, `narrator` (optional): the branch
  decisions over the items (Branches), the sound (Audio) and the
  characters' voices for spoken lines (Voices).

### Schema version

A new optional field, at the top level or on an item, never changes
`schemaVersion`: a folder without it means what it meant before. That
is how `audio`, video `segments`, the game's `version`, `$schema`,
`voices`, `narrator`, `language` and `languages` arrived after Kinetic
1.0.0 with `schemaVersion` still 1.
`schemaVersion` changes only when a folder that was valid stops being
valid or plays differently, and that comes with a major Kinetic
release.

An older player ignores top-level and item fields it does not know: it
reads the fields it was built for and plays the rest of the folder
without the new feature (an older player given a manifest with
`audio`, for example, plays it silently). It still refuses any
`schemaVersion` but 1. An older validator rejects those fields, because
the schema it carries allows no key it does not list.

## Items

Every item carries `id`, `type`, and optional overlay fields:

- `id`: unique ASCII slug matching `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, used
  for stable reference by tools (validator reports, converter logs) and
  by `branches` (Branches below). It contains no dot, so derived
  filenames parse unambiguously. Array position remains the only
  ordering the player reads.
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
- `video` with `file` (a video file with any extension: there is no
  video extension list, and playability is the browser's call; the
  converter ships `.mp4`, `.mov`, `.m4v`, `.3gp`, `.webm` or `.mkv`),
  `poster` (still image shown
  for instant first paint), and the required `durationSeconds`
  (runtime of the encoded video, greater than 0; the converter fills
  it via ffprobe, and skip-mode timing needs it). Optional
  `loopCount` (integer, at least 1, default 1) plays the video
  repeatedly; optional `holdSeconds` (number greater than 0) sets an
  explicit display duration; optional `minPlaySeconds` (number
  greater than 0) is a chain-exit floor, covered under Timing;
  optional `startSeconds` (number, at least 0, default 0) and
  `endSeconds` (number greater than `startSeconds`, default
  `durationSeconds`) play a sub-range of the file; optional
  `loopStartSeconds` (number, at least 0, default
  `startSeconds`) sets where a loop restarts. Video playback ranges
  below covers all three. Optional `segments` (a non-empty array of
  `{startSeconds, loopStartSeconds?, endSeconds}`) lists the file's
  camera views, which Space steps through after the item's lines;
  Video segments below covers it, and no other item type takes it.
  Measured 2026-11-02 (Safari 26.6.2 on an
  M2, headless Chrome 156; a probe page of container x codec samples
  counting decoded frames), video track only, since the player plays
  videos muted (a video's sound is a separate track, `videoSound` under
  Audio):

  | Video codec | Both play it in | Fails in at least one |
  | --- | --- | --- |
  | H.264 | MP4, MOV, M4V, 3GP | MKV, AVI, MPEG-TS |
  | HEVC (`hvc1`) | MP4, MOV, M4V | MKV, MPEG-TS; any `hev1` |
  | VP9 | MP4, WebM, MKV | |
  | VP8 | WebM, MKV | Ogg |
  | AV1, MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263, Theora, FFV1 | none | every container |

  Chrome plays HEVC only through the platform decoder (not with
  `--disable-gpu`); Safari on an M2 decodes no AV1; Firefox was not
  probed. The picture played next to every audio codec tried. The
  converter keeps what both play byte-identical, remuxes H.264/HEVC/
  VP9 from a refused container (or `hev1`) into MP4 without
  re-encoding, and transcodes every other codec to H.264 MP4
  (docs/extracting.md, Video policy), so no video ships that either
  browser cannot play.
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
gated on media end. Rewind, skip, and an `e` landing on a `text` item
show that visual as a still: a video's `poster` or an animation's
`frames[0]`. The first item may not be `text`, and a `text` item only
makes sense after some media-bearing item.

### Video playback ranges

A video item may play a sub-range of its file: `startSeconds` (number,
at least 0, default 0) and `endSeconds` (number greater than
`startSeconds`, default the file's duration, `durationSeconds`). Both
are stored as exact fractional seconds; the schema, the validator, and
the player never round them. Playback duration is `endSeconds -
startSeconds`, and the media gate and skip dwell use the range rather
than the file's duration, as Timing describes. A pass ends when
playback reaches `endSeconds`, not at the file's true end. The player
seeks to `startSeconds` when the item is entered, clamps playback to
`[startSeconds, endSeconds]`, and loops by seeking back when a pass
completes. No video uses the element's own `loop`, which would seek to
0, wrong for a range, and which WebKit holds at a Matroska or WebM
file's end.

A range whose end lies past the start of the file's last frame has no
frame at its end, so its pass ends at the file's end: `endSeconds`
absent or equal to `durationSeconds`, and also, for example, one float
step below `durationSeconds`. The file's end is whichever comes first of
the last frame having shown for one frame interval, a `timeupdate` at
the end while the video plays on (up to about 0.25 s late in WebKit),
and the element's `ended`; the player handles each end once. WebKit
sends `ended` only at a Matroska or WebM file's first end, so no loop
waits for it. A range that runs to the file's end need not set
`endSeconds` to exactly `durationSeconds`.

`loopStartSeconds` (number, at least 0, default `startSeconds`) is the
loop restart point: the first pass runs from `startSeconds` to
`endSeconds`, and every pass after it runs from `loopStartSeconds` to
`endSeconds`, so a clip with an intro plays the intro once and skips
it on the loop-backs. Entering the item again later starts a new first
pass from `startSeconds`. `loopStartSeconds` below `startSeconds` is
legal (a loop may include pre-roll the first pass skipped); above it
is the common case. The validator requires it to be less than the
effective end, `endSeconds` or `durationSeconds` when there is no
`endSeconds`, so a later pass always has length. A chain and a
`holdSeconds` video loop the same way, from `loopStartSeconds`, whose
default falls back to 0 when `startSeconds` is absent too. The poster
is unaffected: it stays the frame at `startSeconds`.

The gate follows the passes rather than the range times `loopCount`:
`firstPass + (loops - 1) * loopPass`, where `firstPass = endSeconds -
startSeconds`, `loopPass = endSeconds - loopStartSeconds`, and `loops
= loopCount`. Without `loopStartSeconds` this is `(endSeconds -
startSeconds) * loopCount` as before, and `holdSeconds` overrides it
as it does now.

Several items may reference the same `file` at different ranges. The
validator checks each item's range against its `durationSeconds` but
neither dedups nor forbids sharing. The file's real duration is the
converter's check (ffprobe); the validator trusts `durationSeconds`.

Posters and stills show the frame at `startSeconds`, including in skip
and rewind, so the converter extracts the poster with `ffmpeg -ss
<startSeconds>`. A hand-authored or test folder that cannot decode to
seek may keep the file's first frame as the poster; the still then
shows the file's start rather than the range's, and the folder's notes
should say so.

As an authoring convenience a range may be expressed as
`startFrame`/`endFrame` at a given fps; the authoring tool converts
each number to fractional seconds (`frame / fps`) and stores that in
the manifest. The manifest field stays fractional seconds, and the
player never sees frame numbers.

Honest caveat: browser `seek` lands on the nearest keyframe, so the
first frame shown after `startSeconds` may be an earlier keyframe;
frame-exact start accuracy depends on the browser and is not
guaranteed. What is guaranteed is that playback stays within the range
and its pass ends at `endSeconds`, or at the file's end for a range
that runs there.

### Video segments

One video file may hold several camera views joined by camera moves. A
video item's optional `segments` lists those views in order, so that
the reader steps through them after the item's lines before leaving
the item. Each segment is an object with `startSeconds`, an optional
`loopStartSeconds` and `endSeconds`, all times in the file in exact
fractional seconds, and no other keys. No other item type takes
`segments`.

The validator checks:

- `segments` is a non-empty array.
- Each `startSeconds` is at least 0.
- Each `endSeconds` is greater than its `startSeconds` and at most the
  item's `durationSeconds`.
- Each `loopStartSeconds` (default the segment's `startSeconds`) is at
  least 0 and less than its `endSeconds`. Below `startSeconds` is
  legal, as for an item: a view whose loop restarts before its camera
  move ends sets `loopStartSeconds` there rather than starting the
  segment earlier, which would overlap the segment before.
- Each segment starts at or after the end of the one before. Segments
  may touch: one ending at `17.04` followed by one starting at `17.04`
  is valid. Comparison is exact, with nothing rounded, so times copied
  as they are from one timing list (`81.03999999999999` included)
  touch, and an overlap of one float step is still an overlap.

Segments may lie outside the item's own `startSeconds`..`endSeconds`
range; they are file times and the range does not bound them.

Space steps segments only on the last item of the video's chain: the
video item itself when no `text` item follows it, else the chain's last
`text` item, so the lines come first. There, when the stage plays that
video (a video a menu holds paused counts; a poster shown as a still
on a `nav` arrival below the seen edge does not), a Space press does
not leave the item. The first press makes the first segment that
starts after the video's current time the active segment, and each
later press steps to the next segment in the list, by index, never by
re-reading the time. With no later segment the press advances as it
would without `segments`, and a decision hanging off the item opens
then. Only a manual Space press steps: auto-forward, skip, an open
choice and an auto-pick never do. Once a segment is active the item's
media gate counts as met, so turning auto-forward on then leaves after
the text hold alone. Every arrival at an item starts with no active
segment.

When the active segment changes, the video seeks once to its
`startSeconds`, plays to its `endSeconds`, then loops
`loopStartSeconds`..`endSeconds` until the next step, counting no
passes. A segment ending past the start of the file's last frame loops
at the file's end, as a range does (Video playback ranges). A
`videoSound` (Audio) follows it: the sound plays the segment and loops
with it. A menu's pause and resume keep the active segment.

Right and Left work on the same item, under the same conditions as
Space's step, and do nothing anywhere else: not in auto-forward or
skip (where an arrow, unlike Space, does not turn the mode off), not
on an open choice, and not while the Esc screen, the Volumes sheet or
the branch map is open, where the arrows keep their own use. A held
arrow steps once. Right steps to the next segment as Space does but
never advances; on the last segment it does nothing. Left steps to
the previous segment: before any step, to the segment before the one
the video's current time is in, or, when the time is in no segment, to
the last one starting before it; after a step, to the one before the
active segment. With no such segment it does nothing.

Each step, by Space, Right or Left, shows "View n of m" for about
1.6 s in the player's notice pill (the route and mode notices' look),
without blocking input: `n` counts from 1 in the item's `segments` and
`m` is their number. A new step replaces a note still showing; leaving
the item lets it fade. Like the other notices it ignores `h`, and a
bookmark's picture does not include it.

Everything else ignores `segments`: the item's own range and its
passes before any step, the poster (still the frame at the item's
`startSeconds`), the media gate until a segment is active,
auto-forward, skip, the wheel, bookmarks, seen marks, the branch map,
a reload and re-entering the item (both play the item's own range from
its `startSeconds`, with no active segment), and the validator's
reachability walk.

Example: the file loops whole under the item's lines, which start at
its second view; after the last line, Space steps through the views
that start after wherever the video then is, then leaves (at once when
the video is already in its last view).

```jsonc
{
  "id": "yard-010", "type": "video", "file": "yard-010.mp4",
  "poster": "yard-010.poster.jpg", "durationSeconds": 30,
  "startSeconds": 10, "loopStartSeconds": 0,
  "segments": [
    {"startSeconds": 0, "endSeconds": 10},
    {"startSeconds": 10, "loopStartSeconds": 12, "endSeconds": 20},
    {"startSeconds": 20, "endSeconds": 30}
  ]
}
```

## Branches

`branches` is an optional top-level array of decision objects laid over
the same item array. The lead-in (everything before a decision's
`after` item) and the aftermath (from `continueAt`) are ordinary
items: they play once, not per route. A decision fires when its
`after` item settles on a forward advance: the player shows an overlay
with the `prompt` above a numbered list of route labels, and a pointer
click, a 1..9 press, or the arrow keys and Enter (which reach routes
past nine) selects. References between decisions, routes,
and items always use ids, never array positions.

- `id`: the decision's id, unique across `branches` and distinct from
  every item id.
- `after`: the item id the decision hangs off. Every route of the
  decision starts after it in array order.
- `prompt`: non-empty question above the route list, shorter than 200
  characters.
- `routes`: at least two route objects — more than two is required,
  exactly like Ren'Py menus. Each route has an `id` unique within its
  decision, a non-empty `label` shorter than 120 characters, and
  `start`/`end`: an inclusive, contiguous span of items in array
  order, `start` not after `end`. The spans of one decision are
  pairwise disjoint and none contains that decision's `after` item.
  A route may contain other decisions (nested branches): the nested
  decision's `after` and routes lie inside the enclosing route's
  span, and returning from a nested decision resumes the enclosing
  route.
- `result`: what happens when a route's span completes. `"ending"`,
  the default, means the route's last item IS the ending: afterwards
  the overlay offers route reselection. `"return"` means that after
  its end the overlay offers route reselection through to the
  decision's join (see the return-row rule below). `"continue"` means
  that after its end flow proceeds to the decision's `continueAt`, as
  the continuing route's does, with no choice screen: the shape for
  alternatives that all lead into one shared scene, written once. It
  needs `continuingRoute`/`continueAt` (a pure choice has no join).
  Stepping off its last item completes that route only, so the return
  row below still waits for the continuing route; for every "flow has
  passed this decision" rule (`u`, the end card) a completed
  `"continue"` route counts as the continuing route's completion does,
  and its last item is not an ending. Under `Play all routes` its end
  re-offers the choice, as a `"return"` route's end does, while a route
  of the decision is unplayed this pass, and joins at `continueAt` once
  none is, so every route still plays once and the shared scene once
  (see below). A route counts as
  played once it is ENTERED - its first content becomes current, by
  any means - so the seen mark appears immediately and an abandoned
  route still counts as seen. The ENTERED mark and the return row are
  DIFFERENT things (docs/plan.md Phase 18): "return to main route" -
  which proceeds to `continueAt` - appears on a decision's re-openings
  and replayed choice screens only once that decision's CONTINUING
  route has
  COMPLETED at least once, been played through to its route end.
  Entered-and-abandoned does not count, and no OTHER route's completion
  opens the row: a continuation the reader has not reached the end of
  is not a place to "return" to. Until the continuing route finishes,
  re-openings offer routes only and picking it is the way forward; its
  own end joining at `continueAt` opens the row, as does finishing it
  from any re-offer. Once it has completed, every re-opening carries
  the row, so an ending is escapable rather than a loop. Completion is
  of the route as it now ends: a restored completion counts only if
  the route's `end` item has been seen, or flow left the route past
  that end through a passed decision nested in it, so a reader who
  finished a route since extended to a new end has not completed it
  until they read to the new end (its seen mark stays). A decision
  with no `continuingRoute` is never offered it. There is
  NO implicit join: an unmarked route never silently merges into the
  main line, because an alternate's later state is not the main
  route's. A continuing route's own `result` is moot — it proceeds to
  `continueAt`.
- `continuingRoute` and `continueAt`: an optional pair naming the one
  route that continues the story and the item id where its aftermath
  begins. `continuingRoute` must name a route of the same decision;
  `continueAt` is required with it and resolves to an item after
  every route's `end`. Without `continuingRoute` the decision is a
  pure-choice decision: `continueAt` is not allowed, "return to main
  route" is never offered, and a completed route returns to the
  decision until every route of it has played — then the decision
  CLOSES and flow continues past the whole menu region (the max route
  `end` plus one, the Ren'Py fall-through), never inside another
  route's span. A region running to the last item ends the story on
  the route just finished, where Space moves nothing, as at the last
  item. Route replay stays possible by navigating into the
  route. "return to main" exists only when `continuingRoute` does -
  and then only once that route has COMPLETED (the rule above), not
  merely entered.

Player-side notes, the format's promises (machine rules in
docs/plan.md Phase 13):

- Showing a decision does not mark its routes' items seen: a route is
  ordinary items, seen when shown.
- The `seen` mark on a route ROW is narrower than that item set: it means
  the route was PLAYED — the reader was routed into it by `choose()` or
  a play-all auto-pick. Navigating or jumping through a route's items,
  or resuming inside one, shows those items and leaves the row unmarked;
  merely firing, viewing or dismissing a decision marks nothing
  (docs/plan.md Phase 16, Branches). The two differ where a jump (a
  bookmark, a restore) lands inside a route the reader never chose.
- Timeline (docs/plan.md Phase 27): the wheel walks the STORY ORDER,
  one screen per notch, back and forth - not a record of what was shown.
  The player remembers the LAST PICK at each decision (a reader's pick, a
  play-all auto-pick or a `u` landing; saved with the progress), and the
  walk follows the last-picked route through each decision; with no pick
  known it takes the longest route (most items) holding seen content. A
  decision's choice screen is a step of its own that the wheel passes
  through like any screen, never halting there: it shows the current seen
  marks and return-row rule with the walk's route highlighted (the look
  of play-all's next pick) - going back, the route that had been taken
  from it; going forward, the route about to be taken. A returning
  route's end leads back to its choice screen and on along the
  continuing route; a continuing route's end, and a `"continue"`
  route's, joins at `continueAt` (story order, whatever `Play all
  routes` does there); an ending route's end stops the walk. Walking
  back from a `continueAt` follows the decision's last-picked route when
  that route joins there and holds anything read, to its last read item
  even when its end is not seen (docs/plan.md Phase 39), else takes the
  continuing route's end, else another joining route end that was read.
  A pure choice (no continuing route)
  closes past its menu region once every route has played, so each of
  its routes, whatever its `result`, leads back to its choice screen and
  on past the region (that screen highlights nothing); a region running
  to the last item stops there. An item comes back inside its enclosing
  route spans. The wheel shows only seen screens and answers, marks and
  plays nothing. Going back it passes over screens not seen, such as
  content added since or skipped by a jump, to the nearest seen one
  (docs/plan.md Phase 39), and with none behind it stays; forward it
  stops before the first unseen screen. Reading on (Space, auto, a
  pick) from where it stopped simply continues from there, and a pick
  from a walked choice screen is a real pick. Route
  flow rewinds with the walk (docs/plan.md Phase 22): a walked-to screen
  counts every decision at or after it, other than the ones enclosing
  it, as unplayed THIS PASS, so reading on from before a decision fires
  it again and plays its routes again as the first time did (under `Play
  all routes`: the countdown, shortest first, the continuing route
  last), while the rows' seen marks and the return row, which are
  cumulative, stay. Walking forward again or `e` puts the pass back as it
  was. `e` goes to the furthest screen read in story order - the highest
  seen item, inside its enclosing route spans - and moves only when
  reading passes it; a no-op there. It does not look for unseen content.
  `u` does (docs/plan.md Phase 18, "Reach unseen content from
  anywhere"): it lands on the next unseen item in array order after the
  cursor, wrapping to earlier content, skipping the reader's own
  continuation (what Space shows next, including the routes of a
  decision none of whose routes has been played), items inside a route
  whose enclosing decision was never reached, and content past a
  decision flow has not passed yet (no route joining at its
  `continueAt` completed - its continuing route or a `"continue"`
  route - or a pure choice with a route unplayed). Landing inside routes opens
  their frames and marks them PLAYED, exactly as picking them would, so
  Space reads on inside the route. Like a bookmark jump it is appended
  to the record.
- End card: on an ending (the array end, an ending route's last item
  but not under play-all, or a route's last item where a pure choice's
  close ended the story, whatever its `result`), with no choice open, a
  small card counts the
  unplayed routes that still hold unseen items, across every decision,
  mentions other unseen content (main line, an aftermath, the rest of
  an abandoned route), and offers `u`. With everything seen it reads
  "You have seen everything." in a manifest with branches; a linear one
  shows nothing. A resume with passed-over unseen content before the
  landing (not counting routes declined at an answered decision) shows
  a quiet notice pointing at `u` until the next key.
  A reload lands on the item that was showing, its choice screen open
  again when it was a live one (one the wheel had walked onto reloads as
  the item under it). Saves from before the timeline (with a reading
  history) load as they are: the last pick at each decision comes from
  that record and the open route frames, and the record is dropped.
- `Play all routes` (a persisted setting, default on since Phase 24:
  Kinetic is interaction-free; a saved Off is kept, and Reset progress
  restores On) is zero-interactivity, with or without auto-forward
  (manual reading still needs Space for each item, but no decision
  waits): every decision still shows its choice screen (first fire and
  each re-offer), with a status line and a draining bar
  counting down. The countdown is the reading time of every word the
  screen draws (prompt, status line with its "Back in time" lead, each
  route label with its `seen` marker, the return row when drawn; not the
  key hint or row numbers) plus comprehension time of 1.5 s and 1 s per
  row, all at the reader's speed (the Esc screen's "Auto-forward speed")
  and never under 2.5 s. The row it will
  pick is marked from the countdown's start; then it is highlighted as
  picked for about 0.7 s and the route starts. The highlight is the only
  change at the pick: the status line keeps its last "picks in 1 s" (the
  seconds never show 0) and the hint keeps "Space picks now". It picks the shortest route not yet played this
  pass (fewest items; see the timeline on rewinding), the
  continuing route last, never the return row, repeats until every route
  has played once this pass, then continues via `continueAt` (a pure choice: past
  the region end, per the rule above). So a `"continue"` route's end
  re-offers the choice while a route is unplayed this pass, and joins at
  `continueAt` once none is. A re-offer's status line leads
  with "Back in time: “<route>” is done.". Space takes the pick at once; a
  digit or click picks another route. Inside a skip-all burst there is
  no countdown, only the highlight, and the burst carries on. A choice
  screen the wheel walks onto waits for a pick, while a reload onto a
  live one counts down again. Turning the setting on over a live choice
  starts its countdown; turning it off cancels it. The journey is
  announced by the render layer: entering a route flashes a "Route:
  <label>" pill — manual pick or auto-pick alike — led by "Back to try
  another route" when a manual pick jumped back in time.
- Decisions fire only on a forward settle of `after`: a wheel step or
  a bookmark jump onto `after` fires nothing. Walking back to `after`
  and pressing forward again re-opens the overlay.
- A pick from a walked choice screen is a real pick: it enters the
  route exactly like a route-end re-selection, and "return to main
  route" works there too where the return-row rule offers it.
- The wheel is never trapped by a choice overlay: a notch in either
  direction leaves any choice screen for the neighbouring screen in
  story order, answering nothing. Space and bookmark jumps do not act
  on a choice screen, and tab and `a` only switch skip or auto-forward
  for after the answer; only its own keys and rows answer it. Skip set
  on a choice starts on the first item the answer shows when it has
  seen content to run through, and is off otherwise.
- Author-written transitions need no schema mechanism: put a
  `text`-only item or a title image at a route span's start or end.

## Timing

The manifest describes content; pacing belongs to the player. Reading speed
("Auto-forward speed" on the Esc screen), skip dwell, and skip-all live in
the player's settings (IndexedDB), never in the manifest. The format defines how the player derives per-item timing from
content:

- Text hold time, in milliseconds, is `textHoldMs = max(minHoldMs,
  codepoints(text) * msPerChar / readingSpeed)`. `codepoints` counts
  Unicode code points, excluding the speaker; `readingSpeed` is the
  player setting (default 1.0); `minHoldMs` and `msPerChar` are
  millisecond-denominated player settings whose defaults are
  `minHoldMs = 1500` and `msPerChar = 60`. An item with no `text`
  holds for `minHoldMs`.
- The player scales `msPerChar` per language (Translations): `text` is
  the text as shown, and its `codepoints` are multiplied by a factor
  for the language that text is in, so the hold is `max(minHoldMs,
  codepoints(text) * msPerChar * factor / readingSpeed)`. Chinese,
  Japanese and Korean say as much in far fewer code points than
  English, so their factors come from the player's own table, measured
  from parallel translations (Simplified Chinese 2.85, Traditional
  Chinese 2.82, Japanese 2.17, Korean 1.96); every other language,
  English included, uses 1, as an alphabetic script's longer text
  already gets its longer hold. A line the chosen language file lacks
  shows the base text and keeps the base language's factor.
- `thought` changes no timing: a thought line holds exactly as the
  same `text` would as dialogue.
- An image auto-advances when its text hold time elapses. A `text`
  item holds for its text hold time and nothing else.
- An item's `voice` line (Item audio) holds auto-forward while the
  reader can hear it: sound on, the Voice volume above 0, and sound
  unlocked, which in a browser happens at the reader's first key or
  click other than Esc or a Cmd, Ctrl or Alt shortcut, and in the Mac
  and Windows apps at launch. Every hold above then lasts at least as
  long as the line, the track's `durationSeconds` less its
  `startSeconds`. Manual advance and skip never wait for a voice.
- An animation's loop time, in milliseconds, is `len(frames) *
  loopCount * 1000 / fps`. Auto-advance fires at the later of loop
  time and text hold time, so the loops complete before the item
  advances on its own.
- A video's media gate is `holdSeconds` when present: the hold is
  time driven only, its pass ends are ignored, and the video plays as
  background. Otherwise auto-advance fires at the later of the end of
  the `loopCount`-th pass and the time bound from Video playback
  ranges, `firstPass + (loopCount - 1) * loopPass`, which without
  `loopStartSeconds` is `(endSeconds - startSeconds) * loopCount`, and
  without a range `durationSeconds * loopCount`. A pass ends at
  `endSeconds` or at the file's end, as Video playback ranges
  describes. The text hold always applies alongside the gate.
- After its last counted pass a video holds paused where that pass
  ended, at `endSeconds` or the file's end, until the item is left or a
  segment step plays it again. The Esc screen and the branch map pause
  a playing video, and closing them resumes it from where it stood; a
  held video stays held. If the browser refuses to play a counted
  video, the player reports every pass it still owes, so auto-forward
  does not wait for ends that cannot come; a play cut short by a menu
  opening is not a refusal.
- A media item followed by `text` items, and the `text` items after
  it, form a chain. The chain advances on text hold times alone. Loop
  completion and pass ends gate nothing while it lasts, and
  the chain's visual plays throughout it, looping in place.
- A video's `minPlaySeconds` is a floor on leaving its chain. When
  the current item is the last of that chain (the next item is not
  `text`) and auto-advance governs the step - normal auto mode, or a
  play-all-routes burst (the zero-interactivity experience is auto) -
  the hold is `max(holdMs, minPlaySeconds * 1000 - chainElapsedMs)`,
  where `chainElapsedMs` is the machine time since the chain's video
  item became current. The chain plays through its dialogue normally
  while the video runs; only leaving the chain waits. Manual advance
  and skip stay immediate - skip's dwell never waits on the floor;
  the floor exists so viewers see the video in auto, and the reader
  who presses tab chose speed. `holdSeconds` remains the whole-item
  display gate for standalone videos; with both on one item, chain
  exit honors both, the max of the requirements. Outside a chain the
  field has no effect beyond the media gate. The floor is per video
  item, not per file: items sharing one file may set different floors.
- Skip mode paces by pictures: each media item shows for a fixed
  player dwell, and a `text` item takes zero time with its line
  hidden. Every line is still stepped onto and marked seen, so skip
  can stop on a line (a decision
  hanging off it, the last seen item) and that line then shows
  normally. An animation contributes `frames[0]` and a video its
  `poster`; both show that still and never play. A video holds for
  `min(skipDwell, gate)`, the media gate above standing in for the
  file's duration. With "skip plays videos" on, a video plays its
  whole gate instead and its chain's lines still take zero time.
- Rewind and skip show `frames[0]` and the poster too, with the one
  exception stated next. A `nav` arrival below the seen edge - a wheel
  step, a bookmark jump, an `e` landing - shows a `text` item as the
  still of the visual it displays.
- Media plays again on a forward advance. The player records how the
  current item was reached: a forward step - a space press or the auto
  timer moving one item on - is an `advance`; every other arrival - the
  wheel, a bookmark jump or restore, an `e` landing, a route entry, skip's
  dwell step, the load landing - is `nav`. An advance plays its media
  wherever the cursor sits, so content read once replays when the
  reader advances back over it, and the visual under a `text` item it
  lands on loops on, as the chain rule says. A `nav` arrival shows the
  stills above while the cursor is below the seen edge; at the edge it
  plays. Skip shows stills either way.
- Because a rewound still never plays, it reports no pass ends: with the
  cursor below the seen frontier on a `nav` arrival - a wheel step, a
  bookmark or `e` landing, a restore - the video gate is the time bound
  alone, the same pass-summed duration, and auto-advance fires when it
  elapses without replaying the clip, the shape an image's gate takes.
  A forward advance below that edge does replay its passes and does
  report them; the bound stays the whole gate there too, because it
  equals that replay, so auto pacing matches playback whether or not the
  element managed to play. At the seen frontier a freshly entered
  video - including one arrived at by navigation - does replay its range
  and counted passes from `startSeconds`, and the pass-end condition
  stays in force there (docs/plan.md Phase 16).

## Audio

Sound is optional. A manifest with no top-level `audio` and no item
`audio` plays silent and validates as before. Every audio field is
optional, and `schemaVersion` stays 1. Tracks are declared once at the
top level, and items name them by id:

```jsonc
{
  "audio": {
    "tracks": {
      "theme": { "file": "media/theme.m4a", "durationSeconds": 184.2,
                 "loopStartSeconds": 12.5 },
      "rain": { "file": "media/rain.webm", "durationSeconds": 30,
                "volume": 0.6 },
      "door": { "file": "media/door.mp3", "durationSeconds": 1.4 },
      "mei-01": { "file": "media/mei-01.mp3", "durationSeconds": 2.8 },
      "hum": { "file": "media/hum.m4a", "durationSeconds": 18.4 }
    }
  },
  "items": [
    {
      "id": "street-001", "type": "image", "file": "street-001.jpg",
      "audio": { "music": "theme", "ambience": ["rain"],
                 "sfx": [{ "track": "door", "delayMs": 400 }] }
    },
    {
      "id": "line-002", "type": "text", "speaker": "Mei",
      "text": "You're early today.", "audio": { "voice": "mei-01" }
    },
    {
      "id": "intro-003", "type": "video", "file": "intro-003.mp4",
      "poster": "intro-003.poster.jpg", "durationSeconds": 18.4,
      "audio": { "music": null, "fadeMs": 2000,
                 "videoSound": { "track": "hum", "duck": 0.3 } }
    }
  ]
}
```

### Tracks

`audio.tracks` is an object from track id to track. A track id has the
item id shape, `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. A track has:

- `file` (required): a media path (Naming conventions) ending in `.mp3`,
  `.m4a`, `.wav`, `.flac` or `.webm`. Ogg (`.ogg`, `.oga`, `.opus`) is
  accepted with a warning, below.
- `durationSeconds` (required, greater than 0): the track's length.
  It is authoritative: the player plays a track up to it, or to the end
  of its decoded samples if they stop sooner, and never reads a
  duration from the file, because WebKit misreports Ogg durations and
  some decoders add samples past the end (Loop-safe formats).
- `startSeconds` (at least 0, default 0): where a play starts, Ren'Py's
  `<from N>`. It is less than `durationSeconds`.
- `loopStartSeconds` (at least 0, default: the track's `startSeconds`):
  where a loop restarts, Ren'Py's `<loop N>`. Without it a loop restarts
  where the track started, as Ren'Py's `<from N>` without `<loop M>`
  does. It is less than `durationSeconds`.
- `loop` (boolean, default true): whether the track loops. It applies
  only when the track is music or ambience.
- `volume` (0 to 1, default 1): the author's level for the track.

Several ids may share one file, for example to start one file at two
points.

Ogg is accepted with a validator warning: Safari plays Ogg only from
Safari 18.4 on macOS 15.4, and the player decodes every track with
`decodeAudioData`, where Vorbis in Ogg loses its first 128 samples in
WebKit while Opus in Ogg starts on the right sample in both engines
(Loop-safe formats). kinetic-media copies Ogg Vorbis and Opus into WebM
without re-encoding, except a looping Opus source, which it re-encodes
to AAC in M4A (docs/extracting.md, "Audio policy"). The rule to copy
Ogg into WebM came first from audio elements, measured 2026-11-09 with
a 12.000 s Vorbis tone in headless Chrome 157 and the WebKit driver on
macOS 27.2: in WebKit the file reported 12.34 s and its clock ran 4-7%
slower than M4A, MP3 and WebM, and in Chrome it played 0.8 s past its
end, while the same stream copied into WebM played right in both.

### The script beside each audio file

Beside each track file `F` the folder holds `F.js`, a script that hands
the player the file's bytes: `rain.webm` has `rain.webm.js`, and
`media/ab/<h>.m4a` has `media/ab/<h>.m4a.js`. Under `file://`,
Chrome refuses `fetch`, and a media element routed into Web Audio gives
only zeros, so the player adds the script as a classic `<script>` and
decodes the bytes itself. Several tracks sharing one file share its
script.

The script is exactly one ASCII line:

```js
__kineticAudio("media/theme.m4a","AAAAHGZ0eXBNNEEgAAACAE00QSBp...");
```

- `__kineticAudio` is a global function the player defines before it
  adds the script.
- The first argument is the track's `file` exactly as the manifest
  names it, written as a JSON string. The player takes the bytes only
  from the script of the file it asked for, under that name.
- The second is the file's bytes in base64: RFC 4648's standard
  alphabet (`A-Z a-z 0-9 + /`) with `=` padding and no line breaks.
- One line feed ends the line. Nothing else is in the file: no
  comment, no BOM, no other whitespace.

The bytes depend only on the path and the file's bytes, so every writer
makes the same script: kinetic-media and kinetic-extract beside each
audio file they ship, `fixtures/build_audio_demo.py`, and
`tools/assemble_folder.py` for a hand-written folder's tracks. The
script is a third larger than its file.

The player reads only the script. A content folder keeps the audio file
beside it: kinetic-extract's and kinetic-media's output, which the build
ledger and `kinetic-media rebuild` describe, and the audio demo. The
folder `tools/assemble_folder.py` assembles for play ships the script
alone and leaves the audio file out, unless an item also shows that file
(docs/packaging.md). The validator accepts either.

### Loop-safe formats

The player loops a track's decoded samples: at `durationSeconds` it
goes back to `loopStartSeconds`. A decoder that shifts the start of the
samples therefore moves every wrap, and the loop may click. Measured
2026-11-11 with a 2.000 s noise probe against its lossless source,
through `decodeAudioData` in Chrome and WebKit (docs/plan.md Phase 47,
item 16):

| Format | Start | Loop-safe |
| --- | --- | --- |
| AAC in M4A | exact in both | yes |
| Vorbis in WebM | exact in both | yes |
| WAV, FLAC | exact in both | yes |
| Opus in Ogg | exact in both | yes, with the Ogg warning above |
| MP3 | 576 samples late in WebKit | no |
| Opus in WebM | first 24 samples lost in Chrome | no |
| Vorbis in Ogg | first 128 samples lost in WebKit | no |

Some formats add samples at the end (Vorbis in WebM 64, AAC in WebKit
up to one 1024-sample frame). When `durationSeconds` is the track's
true length, those lie past it and the loop never plays them.

A track loops when an item names it as `music` or in `ambience` and the
track does not set `loop: false`, and when it is a video's
`videoSound`. Such a track belongs in a loop-safe format; the validator
warns about one that is not. One-shots and voice lines may use any
accepted format. kinetic-media ships a looping track in a loop-safe
format when its request says it loops (docs/extracting.md, "Audio
policy").

### Item audio

Any item type may carry an `audio` object. Every field is optional:

- `music`: a track id, or `null` to stop the music. One music track
  plays at a time; a change crossfades.
- `ambience`: the whole set of ambience loops from this item on, an
  array of distinct track ids. `[]` stops them all. A loop in both the
  old set and the new one plays on unbroken.
- `fadeMs` (at least 0, default 1000): the fade, in milliseconds, for
  this item's music and ambience changes.
- `sfx`: one-shots, an array of `{track, delayMs?, channel?}`. `track`
  is a track id, and `delayMs` (at least 0, default 0) delays the start
  by that many milliseconds. A one-shot with a `channel` name stops the
  one-shot already playing on that channel, as Ren'Py's `play sound`
  does. One-shots without a channel overlap.
- `voice`: a track id, the item's voice line.
- `videoSound`: video items only, `{track, duck?}`. Videos play muted,
  so a video's own soundtrack is a separate track. The track's time is
  the video's media time, so it follows the item's range and loop
  restart point (Video playback ranges). The track lasts at least to
  the item's range end, `endSeconds` or else `durationSeconds`, within
  0.05 s. `duck` (0 to 1, default 1) scales music and ambience while it
  plays.

### What plays at an item

Music and ambience are resolved separately. At each item, a channel
plays the value set by the nearest item at or before it, following the
story back the way the reader came: through the route last picked at
each decision, the path the wheel walks back (Branches, the timeline
note). If nothing on the way back to item 0 sets a channel, that
channel is silent.

- A route's first item inherits from its decision's `after` item.
- A join, the decision's `continueAt` item, inherits from the route
  last picked there.
- An item that sets both `music` and `ambience` pins the state, whatever
  the path.
- One-shots and voice belong to their own item and never carry over.

So no item has to carry a full snapshot, and there is no per-route
table. An example: a decision after `ask` has route `a` (`a-1` to
`a-2`) and route `b` (`b-1`), and both join at `join`.

| Item | Sets | Music there | Ambience there |
| --- | --- | --- | --- |
| `intro` | `music: "theme"`, `ambience: ["rain"]` | theme | rain |
| `ask` | nothing | theme | rain |
| `a-1` | nothing | theme | rain |
| `a-2` | `music: "tense"` | tense | rain |
| `b-1` | `ambience: []` | theme | none |
| `join`, `a` picked last | nothing | tense | rain |
| `join`, `b` picked last | nothing | theme | none |
| `night` | `music: "night"`, `ambience: ["crickets"]` | night | crickets |

`b-1` comes after `a-2` in the item array, but it starts route `b`, so
it inherits from `ask` and `tense` never reaches it. At `join` each
channel walks back through the route last picked: after `a`, the music
is `a-2`'s and the ambience is still `intro`'s. `night` sets both
channels, so it sounds the same whichever route came before it.

How the player applies this, its fades and what it does on a wheel
step, a jump or a skip, is player behaviour (docs/plan.md Phase 47,
items 4 to 6).

## Voices

A game may give its characters voices: every line is then spoken in
its speaker's voice, generated on the reader's machine while they read
(docs/voice-reading.md; docs/plan.md Phase 52). Generating lines needs
an opt-in install outside the folder, which a Kinetic app offers; the
folder itself still plays without it, silently as before. Both fields
are optional, and `schemaVersion` stays 1:

```jsonc
{
  "voices": {
    "Mei": { "file": "voices/mei.flac",
             "text": "The tide is coming in early tonight, I can hear it.",
             "description": "A bright, quick young woman, warm and wry." },
    "Old Theo": { "file": "voices/theo.flac" }
  },
  "narrator": { "file": "voices/narrator.flac",
                "text": "Evening settled over the harbour." },
  "items": [
    { "id": "line-002", "type": "text", "speaker": "Mei",
      "text": "You're early today." },
    { "id": "line-003", "type": "text",
      "text": "The lamps along the quay came on one by one." }
  ]
}
```

- `voices`: an object from speaker name to voice. A key is a speaker
  name exactly as items' `speaker` gives it, case and spaces included,
  and is not empty. A speaker with no voice is fine: their lines stay
  silent.
- `narrator`: one voice, which speaks the lines that have text but no
  speaker (`speaker` absent or empty).

A voice has:

- `file` (required): the reference clip the voice is cloned from, an
  audio file under a track file's rules (Tracks): a media path (Naming
  conventions) ending in `.mp3`, `.m4a`, `.wav`, `.flac` or `.webm`, or
  Ogg's `.ogg`, `.oga` or `.opus`, with its script beside it (The script
  beside each audio file). An assembled folder ships the script alone,
  as it does a track's, and several voices, or a voice and a track, may
  share one file.
- `text` (optional): what the clip says, word for word. Some engines
  clone better given the transcript.
- `description` (optional): the description the voice was designed
  from, kept so the voice can be designed again.

`text` and `description`, when present, hold at least one non-space
character. A voice has no other keys.

A good reference clip is about 10 to 13 seconds of one person's clean
speech: no music, no effects, no other voice, little room echo. FLAC
or WAV keeps it lossless; the clip is not played to the reader, so its
size matters only once per game, not once per line. Ogg is accepted
without the track warning, because the player never plays the clip: it
hands the clip's bytes to the voice engine.

With the voice model installed and the Voice volume above 0, these lines
are spoken:

- an item with text whose `speaker` has a voice, in that voice;
- an item with text and no speaker, in the narrator's voice, when there
  is a `narrator`;
- a thought (`thought: true`) like any other line, in its speaker's
  voice.

An item with a recorded voice line (`audio.voice`, Item audio) always
plays the recording and is never generated. `tools/record_lines.py`
writes such recordings of every line that would be generated, so a game
whose lines are all recorded needs no voice engine; it names its tracks
`rec-` and 32 hex digits and keeps them in `lines/` (CREATE.md,
"Recording the lines"). Speaker names are not spoken, only the text.
Lines are spoken as written: the format has no direction markup. A line is
spoken in the engine's language for the manifest's `language`; with a
translation shown, the shown text in that language's (Translations,
"Spoken lines per language").

The validator warns, without failing, about a voice no item's `speaker`
names and about a `narrator` when no item has text without a speaker.

## Translations

A game can be read in more than one language from one folder
(docs/plan.md Phase 54). `manifest.json` stays in its base language,
named by its `language` field (default `"en"`), and each translation
is a language file beside it. The manifest's `languages` lists the
tags of the language files present:

```text
my-novel/
  manifest.json   # "language": "en", "languages": ["de", "ja"]
  lang/de.json    # the German language file
  lang/de.js      # generated: window.KINETIC_LANGUAGES["de"] = {...};
  lang/ja.json
  lang/ja.js
```

- A language file is `lang/<tag>.json`, the path relative to the
  manifest's directory, its name the tag exactly.
- Beside it goes its script, `lang/<tag>.js`, which contains exactly
  `window.KINETIC_LANGUAGES["<tag>"] = <the language file's JSON>;` and
  a newline. The player creates `window.KINETIC_LANGUAGES` and adds
  the chosen language's script as a classic script, so the folder works
  over `file://` as `manifest.js` does. Only the chosen language loads.
  Both files encode the same JSON; the validator checks this. Run
  inside the content folder, one command writes every script:

  ```sh
  for f in lang/*.json; do t=$(basename "$f" .json); printf 'window.KINETIC_LANGUAGES["%s"] = %s;\n' "$t" "$(cat "$f")" > "lang/$t.js"; done
  ```

- A tag is a BCP 47 language tag of the form
  `language[-Script][-REGION][-variant]`, written in canonical casing:
  the language in lowercase (two or three letters), the script in title
  case (four letters), the region in uppercase (two letters) or three
  digits, a variant in lowercase. `de`, `ja`, `zh-Hans`, `pt-BR` and
  `es-419` are tags; `DE`, `pt-br`, `zh_Hans` and `english` are not.

A language file:

```jsonc
{
  "language": "de",
  "name": "Deutsch",
  "title":   { "text": "Die Laterne bei Ebbe", "from": "1a2b3c4d" },
  "version": { "text": "Folge 3", "from": "5e6f7a8b" },
  "speakers": { "Mei": "Mei", "Old Theo": "Der alte Theo" },
  "items": {
    "title-001": { "text": "Du bist heute früh dran.", "from": "9c0d1e2f" }
  },
  "decisions": {
    "outer": {
      "prompt": { "text": "Wohin jetzt?", "from": "3a4b5c6d" },
      "routes": {
        "route1": { "text": "Zum Hafen", "from": "7e8f9a0b" }
      }
    }
  },
  "voice": {
    "tracks": {
      "rec-01": { "file": "lang/de/lines/rec-01.webm", "durationSeconds": 2.1 }
    },
    "items": { "title-001": "rec-01" }
  },
  "keepOriginalVoice": false
}
```

- `language` (required): the file's tag, equal to its file name
  without `.json`, and one of the manifest's `languages`.
- `name` (optional): the language's name in itself, as the player's
  Language control lists it, at most 40 characters. Absent: the player
  names the language itself (`Intl.DisplayNames`).
- `title`, `version` (optional): the manifest's `title` and `version`
  translated, at most 200 and 40 characters as there.
- `items` (optional): an item id to the translation of that item's
  `text`. Only an item whose base `text` is not blank has an entry.
- `speakers` (optional): a speaker name exactly as the manifest's items
  give it, case and spaces included, to the name drawn in this
  language, which holds a non-space character. The manifest's `speaker`
  stays the speaker's identity, the key of `voices` and of this table;
  the table changes only what is drawn.
- `decisions` (optional): a decision id to an object with an optional
  `prompt`, the translation of the decision's `prompt`, and optional
  `routes`, a route id of that decision to the translation of its
  `label`. A route id is unique only within its decision, hence the
  nesting. The branch limits hold in every language: a prompt is
  shorter than 200 characters and a label shorter than 120.
- `voice` (optional): this language's own recorded voice lines.
  `tracks` maps a track id to a track, exactly as the manifest's
  `audio.tracks` does (Tracks): a media path, its `durationSeconds` and
  the rest, with its script beside the file (The script beside each audio
  file). The ids are this file's own namespace: they may equal the
  manifest's or another language's without meeting them. `items` maps an
  item id to one of those track ids: the item's line in this language.
  By convention the files sit under `lang/<tag>/lines/`, where
  `tools/record_lines.py --lang` writes them (CREATE.md, "Recording the
  lines"). An `items` entry names an item with text and a track of this
  file; one for an item this file gives no text is a validator warning,
  since the line would never play.
- `keepOriginalVoice` (optional, default `false`): `true` plays the
  base recordings of voice lines (`audio.voice`, Item audio) under this
  language's text, like subtitles.
- `$schema` (optional): any string, for editors, as in the manifest.

A translation is an object with:

- `text` (required): the translated string, plain text with at least
  one non-space character. It is set as text, so markup shows
  literally.
- `from` (optional): the first 8 lowercase hex digits of the SHA-256
  of the base string's UTF-8 bytes, exactly as the manifest has it,
  with no normalisation. It records which base text the translation was
  made from, so the validator can tell a translation made before the
  base changed (stale). Without `from` that cannot be checked.

Rules of meaning:

- What is translatable: item `text`, speaker names, decision prompts,
  route labels, and the manifest's `title` and `version`. Nothing else
  is: `thought`, media, timing, audio, branches and every id stay the
  manifest's, the same in every language, apart from voice lines, which
  a language may record for itself (`voice`; Spoken lines per language).
- One item, one text. A translation never splits an item over several
  screens or merges items, so saves, bookmarks, the seen set and
  progress, all kept by id, hold in every language.
- At play time each string falls back to the base on its own: an item,
  speaker, prompt, label, title or version the chosen language file
  lacks shows the manifest's text. A stale translation still shows.
- Pictures are the same in every language, and a language file can
  neither name nor ship a font.
- The player opens a game in the reader's own pick, saved with their
  settings for that `storyId`, while the game still offers it; else in
  the browser's language when the game has it (a loose match: `de-AT`
  takes `de`, `zh-TW` takes `zh-Hant`, `es-MX` takes `es-419` before
  `es`); else in the base. With `languages` listed, the Esc screen's
  title bar has a Language control to switch, which keeps the place,
  picks, seen set and bookmarks. Each string drawn is marked with the
  language it is in, so a fallback line carries the base's tag.

### Spoken lines per language

What voice an item has depends on the language its text is shown in
(docs/plan.md Phase 54 item 6; player/src/render/linevoice.ts). When the
text shown comes from the language file:

1. the file's own recording for the item (`voice.items`), if any;
2. else, with `keepOriginalVoice`, the item's base recording
   (`audio.voice`), if it has one;
3. else a line generated live (Voices) from the translated text, in the
   speaker's voice (or the narrator's), in the voice engine's language
   for the file's tag, when the engine speaks it;
4. else silence. A base recording never plays under a translation
   without `keepOriginalVoice`.

When the text shown is the base's (no language chosen, the base chosen,
or this item's text missing from the file), the manifest's own rule
holds: its `audio.voice`, else a live line of the base text in the
engine's language for the manifest's `language`.

The engine (Chatterbox multilingual) speaks Arabic, Chinese, Danish,
Dutch, English, Finnish, French, German, Greek, Hebrew, Hindi, Italian,
Japanese, Korean, Malay, Norwegian, Polish, Portuguese, Russian,
Spanish, Swahili, Swedish and Turkish. A tag counts by its primary
language: `pt-BR` and `pt-PT` are Portuguese, `zh-Hans` and `zh-Hant`
Chinese, `nb` and `nn` Norwegian. A line in another language is not
generated: it stays silent, unless the file records it. Recorded lines
play in a browser too; generated ones need a Kinetic app with the voice
model, as in the base. The Volumes sheet's Voice row and the model's
download follow the language shown: a language whose every line is
recorded offers no download.

The converter's Python helper for these files is
`converter/kinetic_extract/language_file.py`: the hash
(`base_hash`), tag casing (`canonical_tag`), a writer of a language
file and its script together (`write_language_file`), and the
recorded lines' folder (`voice_lines_dir`).

## Naming conventions

The converter names every file it ships, posters included, by the
sha256 of the bytes it ships: `media/<h[:2]>/<h>.<ext>`, with `<h>` the
64 lowercase hex digits and `<ext>` the true shipped format (docs/plan.md
Phase 25). `media/` is its one fixed folder, and the two-hex-digit bucket
keeps any one directory small. The same bytes get the same path on every
run, so identical outputs are one file whichever items use them. The
name carries no item id: the manifest says which item uses which file,
and the converter's build ledger records where each file came from.

A manifest media path is therefore a path under the content folder root,
not only a name. Its last segment is an id-shaped stem (a 64-hex digest
qualifies), at most one derivative suffix, then the extension. These
default names suit a hand-authored folder, whose files the converter
did not name; since ids contain no dots, their suffixes parse
unambiguously:

- `<id>.<ext>`: the item's own media file, referenced by `file`: the
  display-resolution image of an image item, or the video of a video
  item. `ext` is the true shipped format, `jpg`, `png`, `webp`,
  `jxl`, or `gif` for images and, for video, the true container's
  usual extension (the converter writes `mp4`, `mov`, `m4v`, `3gp`,
  `webm` or `mkv`; any extension validates). Browser-compatible originals are preserved
  byte-identical, with no forced re-encode.
- `<id>.fNNN.jpg`: animation frame N, zero-based and zero-padded to three
  digits, referenced in `frames`.
- `<id>.poster.jpg`: the video's start frame, the frame at
  `startSeconds`, extracted at conversion with `ffmpeg -ss` and
  referenced by `poster`; without a range this is the file's first
  frame. The poster doubles as the first frame shown in skip mode and
  rewind. (The converter ships the same frame, named by its hash.)
- `<id>.thumb.jpg`: a preview no wider than 320 pixels, derived from the
  item's first visual (image, frame 0, or poster). Bookmarks capture the
  visible surface at run time; the thumbnail is the fallback when no surface
  can be captured, such as a video with no decoded frame.

These names are defaults, not a one-file-per-item rule. Multiple items
may reference the same file, and a hand-authored folder may name its
files differently.

The directories in front of that name carry no meaning the manifest does not
state. A path is POSIX-relative to the folder root, its segments separated by
`/` and each made of `[A-Za-z0-9._-]` starting with a letter or digit, so it
can be neither absolute (`/x.jpg`), nor escaping (`media/../x.jpg`,
`../x.jpg`), nor a drive letter or URL scheme, nor contain a backslash, an
empty segment, or whitespace. `media/ab/window-004.jpg` and
`window-004.jpg` are equally valid, and both name a file the player resolves
from the folder root and never parses. Subpaths are an option for a
hand-authoring author, never a requirement: a small folder stays flat.

The manifest stays authoritative: the player reads exactly the files
the manifest references, never a directory scan. A folder may carry
extra unreferenced files, such as the converter's build ledger and its
schema copy (`manifest.schema.json`); the player and the validator ignore
them.

## Rules and validator invariants

Format rules:

- Paths are relative to the content folder, and may name a subfolder of it
  (`media/ab/window-004.jpg`). The schema pattern enforces the character
  set: every segment is `[A-Za-z0-9._-]` starting with a letter or digit, so
  no leading `/`, no drive letters or scheme, no `..`, no empty segment, no
  backslash, no spaces. The last segment stays a flat file name — an
  id-shaped stem (a converter sha256 stem fits), at most one derivative suffix (`.fNNN`, `.poster`,
  `.thumb`), then the extension.
- Images carry the extension `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`,
  or `.jxl` (the schema pins these on image fields); a video file may
  carry any extension.
- Audio track files carry `.mp3`, `.m4a`, `.wav`, `.flac` or `.webm`,
  or Ogg's `.ogg`, `.oga` or `.opus`, which pass the schema with a
  validator warning (Audio). A voice's `file` carries the same
  extensions, Ogg without the warning (Voices).
- Every media value matches the path pattern.

The validator checks the schema plus these invariants:

1. `manifest.json` validates against `docs/content-schema.json`.
2. Every path in the manifest resolves to an existing file in the
   folder, except an audio track file or a voice's `file` whose script
   is there instead (17, 18).
3. Item ids are unique.
4. `schemaVersion` is 1; `storyId`, when present, is a slug as above;
   `title`, when present, is non-blank text of at most 200 characters;
   `version`, when present, is non-blank text of at most 40 characters;
   `items` is an array (an empty one is valid — an
   honestly-empty folder, see Manifest); `frames` has at least two
   entries; `loopCount` is at least 1; `fps` and `durationSeconds` are
   greater than 0; `minPlaySeconds`, when present, is greater than 0;
   `width` and `height` are at least 1; a track's `startSeconds` and
   `loopStartSeconds` are at least 0; `volume` and `duck` are in
   [0, 1]; `fadeMs` and `delayMs` are at least 0. The schema enforces
   all of these.
5. When `manifest.js` is present, the embedded JSON parses equal to
   `manifest.json`.
6. An item sets `thought` true only when its `text` is non-empty. The
   schema cannot express this cross-field rule, so the validator reports
   it.
7. A video's playback range is sound: `startSeconds` is not negative,
   `endSeconds` is greater than `startSeconds`, `endSeconds` does
   not exceed `durationSeconds`, and `loopStartSeconds` is less than
   the effective end `endSeconds ?? durationSeconds`. The schema
   pins `startSeconds` and `loopStartSeconds` to at least 0; the
   validator reports the negative value and the cross-field rules.
   The validator trusts `durationSeconds`; the file's real duration
   is checked by the converter (ffprobe).
8. A video's `segments` are sound (Video segments): each
   `startSeconds` and `loopStartSeconds` is not negative, each
   `endSeconds` is greater than its `startSeconds` and does not exceed
   `durationSeconds`, each `loopStartSeconds` is less than its
   `endSeconds`, and each segment starts at or after the end of the one
   before. Values are compared exactly, so touching segments pass. The
   schema keeps `segments` to video items, non-empty, with no other
   keys; the validator reports the negative values and the cross-field
   rules.
9. Branch ids are unique: a decision `id` appears once in `branches`
   and is distinct from every item id; a route `id` is unique within
   its decision.
10. Branch references resolve: `after`, every route `start`/`end`, and
    `continueAt` name existing item ids, and `continuingRoute` names a
    route of its own decision.
11. Route spans are sound (Branches): `start` is not after `end`;
    one decision's spans are pairwise disjoint and none contains its
    own `after` item; `after` precedes every route `start`; and
    `continueAt` resolves to an item after every route `end`.
12. `continuingRoute` and `continueAt` require each other: the schema
    cannot express this pairing, so a `continuingRoute` without
    `continueAt`, or a `continueAt` without `continuingRoute`, is a
    problem. A route whose `result` is `"continue"` on a decision
    without both is a problem too: there is no join to continue to.
13. A decision `prompt` is shorter than 200 characters and every
    route `label` shorter than 120.
14. A track's `startSeconds` and `loopStartSeconds` are less than its
    `durationSeconds`.
15. Audio references resolve: every track id an item's `audio` names
    (`music`, each `ambience` entry, each `sfx` `track`, `voice`, the
    `videoSound` `track`) is a key of `audio.tracks`, and one item's
    `ambience` ids are distinct. An item `audio` with no top-level
    tracks is one problem for that item.
16. `videoSound` is only on video items (the schema allows it nowhere
    else), and its track's `durationSeconds` is at least the item's
    range end, `endSeconds ?? durationSeconds`, less 0.05 s.
17. Each audio track file has its script beside it, `<file>.js`, and the
    script is the one line Audio describes for that file: it names the
    file and holds its bytes. A track may ship its script alone, as an
    assembled folder does: the script is then the one line naming the
    file, inside the folder, and the file's format is read from the
    bytes it holds. A track with neither its file nor its script is a
    problem.
18. `voices` and `narrator` (Voices): each `voices` key is a non-empty
    string; each voice is an object with a `file`, optional `text` and
    `description` that hold a non-space character, and no other keys
    (the schema enforces these). Each voice's `file` has its script as
    a track file does (17), checked once per file however many tracks
    and voices name it.
19. `language` and each `languages` entry are language tags in
    canonical casing (Translations; the schema's pattern, which the
    validator reports as a malformed tag or with its canonical
    spelling); `languages` repeats no tag and does not hold the base
    `language` (`"en"` when absent).
20. For each tag in `languages`, `lang/<tag>.json` and `lang/<tag>.js`
    exist with exactly those names, the script is the one line
    Translations describes, and its JSON parses equal to the language
    file's, compared as manifest.js is (5).
21. Each language file validates against `docs/lang.schema.json`: a
    `language` tag, translations with a non-blank `text` and an
    optional 8-hex-digit `from`, non-blank speaker names, a `title` of
    at most 200 characters and a `version` of at most 40, and no other
    keys. Its `language` equals its file name.
22. A language file names only what the manifest has: each `items` key
    is the id of an item whose base `text` is not blank; each
    `speakers` key is the `speaker` of an item with text; each
    `decisions` key is a decision id, and each of its `routes` keys a
    route of that decision. A translated prompt is shorter than 200
    characters and a translated label shorter than 120, as in 13.

The validator also warns about three things that are not problems: an
Ogg track file (Audio says why), a looping track in a format that is
not loop-safe (Audio, Loop-safe formats; a WebM or Ogg file's codec is
read from its head), and a track no item uses. Each warning is one
`warning: manifest.json: <location>: <reason>` line on stderr, followed
by a count. Warnings leave stdout and the exit status alone, and a
manifest without audio prints none.

After the audio warnings it warns, in the same form, about a voice in
`voices` no item's `speaker` names (`no item's speaker is '<name>'`)
and about a `narrator` when no item has non-blank text without a
speaker (`no item has text without a speaker`), followed by a count
(`N voice warnings`). A manifest without voices prints none.

It also warns, before any audio warning, about each item that no
reading from the opening ever shows: one `warning: manifest.json:
items[N]: item '<id>' is never shown: <why>` line on stderr per item,
in item order, followed by a count (`N unreachable item warnings`).
The validator replays the player's own forward flow under `Play all
routes` (player/src/machine/machine.ts), which shows every item any
reading by choices shows, so these are items only a bookmark or `u`
could land on. An item inside a decision's region, after its `after`
item and before its `continueAt` (for a pure choice, up to its last
route end), that lies in none of its routes reads `inside decision
'<id>' (after '<after>', before '<continueAt>') in none of its routes`;
a nested decision's region lies inside its enclosing route, so the
check holds at every level. Any other reads `no reading from the
opening reaches it`: the routes of a decision whose `after` item the
flow never settles on, or what lies past a route end the flow reaches
with no decision of it open (a join that lands inside another
decision's route), where the story ends (Branches). The warning leaves
stdout and the exit status alone, and a manifest without branches
prints none. `check-game` finds the same items by walking (exit 3,
"never shown").

After the voice warnings it warns about translations, in the same form
with the language file's path in place of `manifest.json`:

- a `lang/*.json` file the manifest's `languages` does not list
  (`not listed in manifest.json languages, so the player never loads
  it`);
- per listed language, each base string its file lacks: the title, the
  version, a speaker, an item with text, a prompt or a route label
  (`no translation (base: '<text>')`);
- each stale translation, whose `from` is not the hash of the base
  text as it is now (`stale: ...`);
- each item text longer than 1.5 times its base text, or longer than
  the game's longest base item text, counted in code points.

Each kind lists at most 20 lines per language, then one line counting
the rest. Then comes one coverage line per listed language, such as
`my-novel: de: 412 of 415 strings (99.2%), 3 stale, 0 unchecked`: the
base strings it translates of all of them (the percentage rounded down,
so only a complete language reads 100%), how many of those are stale,
and how many carry no `from` and so cannot be checked, which is not a
warning. A count of the warnings follows (`N translation warnings`).
These leave stdout and the exit status alone, and a manifest without
`languages` and without language files prints none.
