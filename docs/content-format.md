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
  these indexes. The array may be empty: an empty manifest is a valid,
  honestly-empty folder — a converter run in which no visual resolved to
  a file ships no items rather than placeholders — and the player renders
  its no-content state for it.

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
- `video` with `file` (any browser-playable video file: `.mp4`,
  `.webm`, `.mkv` (VP9/AV1), `.mov`, and `.m4v` are allowed, and
  playability is the browser's call), `poster` (still image shown
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
  below covers all three. MKV is reliably Chromium-class and Safari
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

### Video playback ranges

A video item may play a sub-range of its file: `startSeconds` (number,
at least 0, default 0) and `endSeconds` (number greater than
`startSeconds`, default the file's duration, `durationSeconds`). Both
are stored as exact fractional seconds; the schema, the validator, and
the player never round them. Playback duration is `endSeconds -
startSeconds`, and the media gate and skip dwell use the range rather
than the file's duration, as Timing describes. `ended` is emitted when
playback reaches `endSeconds`, via a `timeupdate` clamp, not at the
file's true end. The player seeks to `startSeconds` when the item is
entered, clamps playback to `[startSeconds, endSeconds]`, and loops by
seeking back to `startSeconds` when a pass completes; `loop=true`
would seek to 0, which is wrong for a range.

`loopStartSeconds` (number, at least 0, default `startSeconds`) is the
loop restart point: the first pass runs from `startSeconds` to
`endSeconds`, and every pass after it runs from `loopStartSeconds` to
`endSeconds`, so a clip with an intro plays the intro once and skips
it on the loop-backs. Entering the item again later starts a new first
pass from `startSeconds`. `loopStartSeconds` below `startSeconds` is
legal (a loop may include pre-roll the first pass skipped); above it
is the common case. The validator requires it to be less than the
effective end, `endSeconds` or `durationSeconds` when there is no
`endSeconds`, so a later pass always has length. The poster is
unaffected: it stays the frame at `startSeconds`.

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
and its `ended` fires at `endSeconds`.

## Branches

`branches` is an optional top-level array of decision objects laid over
the same item array. The lead-in (everything before a decision's
`after` item) and the aftermath (from `continueAt`) are ordinary
items: they play once, not per route. A decision fires when its
`after` item settles on a forward advance: the player shows an overlay
with the `prompt` above a numbered list of route labels, and a pointer
click or a 1..9 press selects. References between decisions, routes,
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
  the overlay offers route reselection. `"return"` means that
  after its end the overlay offers the still-unseen routes plus
  "return to main route", which proceeds to `continueAt`. A route
  counts as played once it is ENTERED - its first content becomes
  current, by any means - so the seen mark appears immediately and an
  abandoned route still counts as seen. Once ANY route of a decision
  has been entered, every re-opening of that decision offers
  "return to main route" whenever `continuingRoute` exists - whatever
  result the route that just finished had, so an ending is escapable
  rather than a loop. Before any route has been entered, no such
  offer appears. There is
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
  route's span; route replay stays possible by navigating into the
  route. "return to main" exists only when `continuingRoute` does.

Player-side notes, the format's promises (machine rules in
docs/plan.md Phase 13):

- Showing a decision does not mark its routes' items seen: a route is
  ordinary items, seen when shown.
- The `seen` mark on a route ROW is narrower than that item set: it means
  the route was PLAYED — the reader was routed into it by `choose()` or
  a play-all auto-pick. Navigating or jumping through a route's items,
  or resuming inside one, shows those items and leaves the row unmarked;
  merely firing, viewing or dismissing a decision marks nothing
  (docs/plan.md Phase 16, Branches). The two differ exactly where a
  back-scroll from one route's aftermath crosses another route's span.
- `Play all routes` (a persisted setting, default off) is
  zero-interactivity: at a decision it auto-picks the first
  not-yet-played route in manifest order, repeats until every route has
  played once, then continues via `continueAt` (a pure choice: past the
  region end, per the rule above). A navigation ARRIVAL at a decision no
  route has ever been played for resolves it on the spot — the no-stop
  path never waits on an overlay it will not show. A decision with a
  played route is not resurrected by an arrival: its unplayed routes stay
  reachable as unseen items (`e` lands on them), or through the normal
  forward-settle re-fire of `after`, which play-all answers as any other
  fire. The journey is announced by the render layer: entering a route
  flashes a "Route: <label>" pill — manual pick or auto-pick alike — led
  by "Back to try another route" when the entry jumped back in time.
- Back/forward navigation walks the item array; entering a route's
  first item that way does not re-fire the decision — decisions fire
  only on a forward settle of `after`. So backing into `after` and
  pressing forward again re-opens the overlay.
- Author-written transitions need no schema mechanism: put a
  `text`-only item or a title image at a route span's start or end.

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
  `loopCount`-th `ended` event and the time bound from Video
  playback ranges, `firstPass + (loopCount - 1) * loopPass`, which
  without `loopStartSeconds` is `(endSeconds - startSeconds) *
  loopCount`, and without a range `durationSeconds * loopCount`.
  `ended` is emitted when playback reaches `endSeconds`, via a
  `timeupdate` clamp, not the file's true end. The text hold always
  applies alongside the gate.
- A media item followed by `text` items, and the `text` items after
  it, form a chain. The chain advances on text hold times alone. Loop
  completion and the `ended` event gate nothing while it lasts, and
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
- Skip mode shows each item for a fixed player dwell. An animation
  contributes `frames[0]` and a video its `poster`; both show that
  still and never play. A video holds for `min(skipDwell, gate)`, the
  media gate above standing in for the file's duration.
- Rewind and skip show `frames[0]` and the poster too, with the one
  exception stated next. A `nav` arrival below the seen edge - a wheel
  step, a bookmark jump, the `e` jump - shows a `text` item as the
  still of the visual it displays.
- Media plays again on a forward advance. The player records how the
  current item was reached: a forward step - a space press or the auto
  timer moving one item on - is an `advance`; every other arrival - the
  wheel, a bookmark jump or restore, the `e` jump, a route entry, skip's
  dwell step, the load landing - is `nav`. An advance plays its media
  wherever the cursor sits, so content read once replays when the
  reader advances back over it, and the visual under a `text` item it
  lands on loops on, as the chain rule says. A `nav` arrival shows the
  stills above while the cursor is below the seen edge; at the edge it
  plays. Skip shows stills either way.
- Because a rewound still never plays, it reports no `ended`: with the
  cursor below the seen frontier on a `nav` arrival - a wheel step, a
  bookmark or `e` landing, a restore - the video gate is the time bound
  alone, the same pass-summed duration, and auto-advance fires when it
  elapses without replaying the clip, the shape an image's gate takes.
  A forward advance below that edge does replay its passes and does
  report them; the bound stays the whole gate there too, because it
  equals that replay, so auto pacing matches playback whether or not the
  element managed to play. At the seen frontier a freshly entered
  video - including one arrived at by navigation - does replay its range
  and counted passes from `startSeconds`, and the `ended` condition
  stays in force there (docs/plan.md Phase 16).

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
- `<id>.poster.jpg`: the video's start frame, the frame at
  `startSeconds`, extracted at conversion with `ffmpeg -ss` and
  referenced by `poster`; without a range this is the file's first
  frame. The poster doubles as the first frame shown in skip mode and
  rewind.
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
4. `schemaVersion` is 1; `items` is an array (an empty one is valid — an
   honestly-empty folder, see Manifest); `frames` has at least two
   entries; `loopCount` is at least 1; `fps` and `durationSeconds` are
   greater than 0; `minPlaySeconds`, when present, is greater than 0;
   `width` and `height` are at least 1. The schema enforces
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
8. Branch ids are unique: a decision `id` appears once in `branches`
   and is distinct from every item id; a route `id` is unique within
   its decision.
9. Branch references resolve: `after`, every route `start`/`end`, and
   `continueAt` name existing item ids, and `continuingRoute` names a
   route of its own decision.
10. Route spans are sound (Branches): `start` is not after `end`;
    one decision's spans are pairwise disjoint and none contains its
    own `after` item; `after` precedes every route `start`; and
    `continueAt` resolves to an item after every route `end`.
11. `continuingRoute` and `continueAt` require each other: the schema
    cannot express this pairing, so a `continuingRoute` without
    `continueAt`, or a `continueAt` without `continuingRoute`, is a
    problem.
12. A decision `prompt` is shorter than 200 characters and every
    route `label` shorter than 120.
