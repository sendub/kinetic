# Implementation Plan

Build order for Kinetic. Each phase is one focused task sized for an
implementing subagent working in clean context under 256k: the inputs are
this repo plus the named files, and the acceptance checks are runnable or
walkable in one sitting. Track completion in docs/progress.md. Read
docs/stack.md before implementing; its decisions are settled unless a
Revisit trigger fires.

## Architecture

Two artifacts sharing one file format:

```text
player/       TypeScript static web app (esbuild bundle + index.html)
converter/    Python package: Ren'Py project -> content directory
fixtures/     demo content pack and synthetic Ren'Py projects
docs/         stack.md, plan.md, progress.md, content-format.md
```

- The player loads a content directory (manifest.json + media files), runs
  a pure timeline state machine, and renders through a thin DOM layer.
  Key handling and the wheel map onto machine commands.
- Item types: `image`, `animation`, `video`, and `text`. A `text` item
  carries only speaker/text and keeps the visual shown by earlier items
  playing underneath, so several lines can advance over one continuous
  looping video or animation (a common shape in kinetic adaptations of
  non-kinetic games, e.g. one episode of a converted corpus game, in a
  dialogue script about 1,700 lines long).
- The converter emits exactly what the player expects; the demo fixture is
  hand-built by script, not by the converter, so each side can be tested
  against the format alone.
- State machine modules import nothing from the DOM; renderer modules
  import nothing from each other. The subscribe/notify seam between machine
  and renderer is the only coupling.

## Phase 1: Player scaffolding

Goal: an empty app that builds, serves, lints, and tests.

- Init `player/` with npm: TypeScript strict, esbuild build to
  `dist/index.html` + single classic `app.js`, Biome, Vitest.
- Scripts: `dev` (esbuild watch + serve), `build`, `test`, `check`.
- `index.html` shows a placeholder; no app code yet.

Acceptance: all four scripts exit 0; `dist/index.html` opens over
`file://` with no console errors; `npm run check` passes.

## Phase 2: Content format and demo fixture

Goal: the contract both artifacts target, plus content to develop against.

- Write docs/content-format.md: item types `image`, `animation` (frames,
  fps, loop count), `video` (file, poster, first frame), fields for text
  overlay and speaker, manifest ordering, and naming conventions. Include
  a JSON Schema file in `player/` or `docs/`.
- Write `fixtures/build_demo.py` (Pillow + ffmpeg) producing
  `fixtures/demo/`: several distinct images, one 4-frame animation, one
  2 s H.264 video with poster, and text overlays including a speaker name.
- Add a validator script (Python or TS) that checks a content directory
  against the schema.
- Write top-level CREATE.md: the guide to making a new kinetic game from
  content you already have (images, animation frame sets, videos, script
  text), covering the content folder layout per the schema, validation,
  and playing it; point the Ren'Py path at the converter.

Acceptance: `build_demo.py` runs clean twice with identical output;
validator passes on `fixtures/demo/` and fails on a deliberately broken
manifest (add it to tests); CREATE.md names only fields the schema
defines.

## Phase 2b: Format revision from external review (2026-10-31)

Another agent building a real timeline (a converted corpus game) reviewed
the format. Four changes follow; Phases 3-9 build against the revised
format.

- 2b.1 Fix docs: the timing formula in docs/content-format.md mixes
  seconds and milliseconds (`max(minHold, chars*msPerChar/speed)/1000`
  with `minHold=1.5` yields 0.06 s for a 1-char line). The implementation
  is already correct (all-ms: `max(minHoldMs=1500, chars*msPerChar/
  speed)`); rewrite the doc formula to match the code. Document the `text`
  item type (no media fields; hold is text-only; shows the nearest earlier
  item's visual, which keeps playing/looping while a `text` item follows
  it; rewind and skip show that visual's still). State that multiple items
  may reference the same derivative file and the converter dedups
  identical sources, so naming conventions describe generated defaults,
  not a one-file-per-item mandate. Note that a content folder may carry
  extra unreferenced files (e.g. the converter build ledger). Sync
  CREATE.md: worked `text`-chain example and the reuse note.
- 2b.2 Schema and validator: add the `text` item variant (required
  `[id, type]`, optional `speaker`/`text`, no media fields,
  additionalProperties false); rules: the first item is not `text`, and a
  `text` item must have some media-bearing item before it. New pytest
  fault tests (leading `text`, text-only manifest) and a test that extra
  unreferenced files are tolerated.
- 2b.3 Machine: `text` item type; its hold is `textHoldMs` only; a media
  item whose next item is `text` also holds text-only and its video loops
  / animation keeps looping underneath the chain (advance is never gated
  on media end while the chain lasts); expose a helper mapping a cursor
  on a `text` item to the index of the visual it displays; rewind, skip,
  and e-jump land on `text` items per the doc rules. Tests per behavior.
- 2b.4 Fixtures: extend `fixtures/build_demo.py` with a video + two
  `text` lines (looping video under dialogue) and an image + two `text`
  lines; all gates green: machine tests, validator, fixture determinism.

Acceptance: all four land with the three suites green
(vitest, pytest, fixture rebuild) and docs/schema/CREATE agreeing on the
`text` semantics.

## Phase 3: Timeline machine - core

Goal: the README's timeline semantics as pure TypeScript, fully unit
tested.

- Model: load manifest items, `cursor` (what is shown), `frontier` (first
  never-shown item; first-ever load starts at item 0, later loads resume at
  the frontier), advance (space), auto-advance timer with a reading-speed
  setting, animation loop counts, video-completion event input, wheel-back
  and wheel-forward rules (back through seen items; forward never past the
  frontier).
- Machine exposes commands in, state out; time comes from an injected
  clock/timer so tests are deterministic.
- Tests cover each README rule, including the frontier boundary and
  wheel-into-unseen rejection.

Acceptance: `npm test` green; the advance, auto-advance, and scroll-wheel
bullets in README §Gameplay features each map to named tests; no DOM
imports in the machine modules (enforced by lint rule or review).

## Phase 4: Timeline machine - skip and jumps

Goal: tab skip mode and e-jump semantics in the same machine.

- Skip mode: fixed fast per-item rate, animations and videos contribute
  their first frame only, mode ends at the frontier unless the `skip_all`
  setting is enabled.
- `e` jump: move cursor to the item immediately before the frontier
  (the state a reload restores).
- Extend tests for mode transitions (space or wheel cancels skip), and for
  `skip_all` on and off.

Acceptance: `npm test` green including the new cases; the skip (tab) and
unseen-jump (e) bullets in README §Gameplay features each map to named
tests.

## Phase 5: Player shell rendering

Goal: see real content, driven by the machine.

- Manifest loader (fetch, or embedded JSON for `file://` mode via a
  generated `manifest.js` shim if needed), machine wiring, DOM renderer
  for image items, text + speaker overlay, `h` toggles text, space
  advances, first keypress or click requests fullscreen.
- Keyboard handler module owns the key map; renderer subscribes to machine
  state.
- Write `docs/verify-player.md`: the manual browser checklist (demo
  fixture, keys so far).

Acceptance: demo fixture plays start to finish in Chrome via keyboard,
checklist walked and recorded in progress.md; unit tests still green.

## Phase 6: Animation and video rendering

Goal: both remaining item types render correctly.

- Animations: frame timer at manifest fps, loop the manifest count, show
  frame 0 when the item is viewed in rewind or skip.
- Videos: `<video muted playsinline>` from the poster to instant first
  paint, autoplay muted, machine notified on `ended`; rewind and skip show
  the poster/first frame, never play.
- `h` hides text over video too.

Acceptance: manual checklist extended and walked on the demo fixture; loop
count and first-frame behaviors observable; tests green.

## Phase 7: Wheel scroll wiring

Goal: scroll wheel rewinds and returns through content.

- Wheel-up steps back through seen items, wheel-down steps forward to the
  frontier, per the machine rules; debounce wheel deltas into discrete
  steps.
- Verify combined flow: space, tab, wheel, e, reload-resume.

Acceptance: checklist walked end to end on the demo fixture; machine tests
unchanged or extended; tests green.

## Phase 7b: Presentation revision (2026-10-31, user requests)

Two additions on top of Phase 7, plus one deferral.

- Fill the screen: media (image items, animation frames, videos) scales
  to fill the viewport as much as possible without changing its aspect
  ratio - the largest centered contain fit, letterboxing the remainder,
  independent of the manifest display size. Runtime rule; the converter
  still pre-sizes assets, the player fits what it is given to whatever
  screen it gets.
- Thought text: overlay text is either dialogue spoken by a character or
  the unspoken thoughts of a character, and the two must read
  differently. Format addition: optional boolean `thought` (default
  false) on items carrying text; `true` marks the line as `speaker`'s
  unspoken thought. Validator: `thought` only allowed where text is
  present. Renderer: overlay exposes `data-mode="speech|thought"` and
  applies a default distinction (thought italic, dialogue upright); all
  styling lives in CSS so the look can change without touching logic.
  CREATE.md and the demo fixture gain a thought line.
- Deferred (needs the user): the final look of overlay text, including
  how thought differs from dialogue, is an iteration to run with the
  user once a playable demo exists. Until then keep the default
  distinction minimal and CSS-only; do not invest in styling depth.

Acceptance: README, docs, schema, validator, renderer, demo fixture, and
verify steps agree on both rules; `data-mode` assertion in verify.mjs;
contain-fit asserted by geometry in verify.mjs.

## Phase 8: Bookmarks

Goal: b/t/e work as one feature.

- Capture the currently visible surface as a thumbnail via canvas (image
  bitmap, animation frame, or video frame through `drawImage`).
- Append `{timestamp, itemIndex, thumbnailBlob}` to an IndexedDB list on
  `b`; brief confirmation flash.
- `t` overlay: scrolling list rendered bottom-first (most recent visible);
  click resumes at that item, closing the overlay. (Superseded by Phase
  35: the `t` overlay is gone, `t` does nothing, and the bookmarks are
  cards on the branch map.)
- Reload restores bookmarks, frontier, and cursor (resume at frontier).
- Storage behind an interface so machine-level tests use a fake.

Acceptance: manual checklist for capture of all three item types, click
resume, and persistence across reload; storage and jump logic unit tested.

## Phase 9: Config screen

Goal: c opens a config overlay; settings persist and apply live.

- Settings: reading speed (auto-advance delay), `skip_all` toggle. Esc or
  c closes; focus handling for clicks.
- Persist to IndexedDB; machine reads settings through its config input,
  never storage directly.

Acceptance: change speed mid-play and see it apply; setting survives
reload; machine tests for config changes green; checklist walked.

## Phase 10: Ren'Py extractor MVP

Goal: `python -m kinetic_extract <renpy_project> <out_dir>` on source
`.rpy` projects.

- Python package `converter/` (name it per its pyproject), CLI, statement
  parser subset from docs/stack.md, asset pass per the Phase 9b policy:
  preserve compatible video/audio-native files as-is and transcode only
  what no target browser plays; images preserved byte-identical when the
  true format is browser-compatible, else converted (lossless JPEG XL
  when smaller, else PNG/JPEG); emit posters and first frames with
  Pillow and ffmpeg. No display-resolution downscaling is needed for
  playback (fill-the-screen CSS scales at runtime); downscale only when
  an asset's bytes are huge, recording the choice in the ledger.
- Build `fixtures/renpy_demo/`: a synthetic project (script.rpy + assets)
  exercising the subset; golden manifest comparison in pytest.
- Unrecognized statements are reported, never fatal.
- Asset handling (external review): detect real formats by content
  sniffing, never by extension (corpus files lie); decode wrapped or
  obfuscated images to standard formats at conversion time (originals
  never reach the player; activation-removal work on the corpus has
  decoding leads); dedup identical source files into one shared
  derivative referenced by many items.
- Write `build-ledger.json` into the output folder (item id -> source
  script paths, source asset paths, branch/skip notes). It is an extra
  unreferenced file: the player and validator ignore it, tools may read
  it.

Acceptance: pytest green; extracting `renpy_demo` yields a directory the
player plays end to end (walk the checklist once on extracted content).

## Phase 11: Extractor completeness on the real corpus

Goal: handle real Ren'Py releases across the packaging kinds they
actually use.

- Corpus: the corpus root (AGENTS.md) holds many games organized in
  category folders with status subfolders, plus Mac `.app` bundles and
  `.zip`/`.rar` releases, some marked broken. Inspect and use it
  read-only.
- Choose a few distinct kinds and take a few random content slices from
  each: a Mac `.app` (game lives under `Contents/Resources/`), a loose
  project dir, a `.zip` (unpack to a scratch dir first), source `.rpy`
  and compiled-only `.rpyc`, `.rpa` archives, and `.rpak` if any game has
  one. A slice is a short contiguous run of items plus its media, not a
  whole game.
- Vendor unrpyc (pin the fetched revision under `converter/vendor/`) and
  decompile `*.rpyc` when `.rpy` is absent; implement the `.rpa` reader;
  `.rpak` only if the corpus contains one.
- Fix ordering and attachment issues the slices surface, and any wrapped
  or misdetectable asset formats they reveal; record per-game inputs,
  kinds, and outcomes in docs/extracting.md.

Acceptance: every sampled slice extracts to a content folder that plays
in the player; docs/extracting.md has an entry per sampled game incl.
what was skipped; every new parser branch is covered by pytest.

## Phase 12: Performance, packaging, docs

Goal: prove the speed budget and ship instructions.

- Preload cursor +/- N items as ImageBitmaps with an LRU cache; tune N.
- Perf harness: scripted navigation over the demo and the extracted game,
  measuring paint-to-paint latency; report p50/p95. Target p95 < 41 ms.
- Self-contained novel folder: the converter copies the player bundle
  (`index.html`, `app.js`) into its output; double-clicking `index.html`
  on a fresh copy plays over `file://`.
- docs/packaging.md: folder layout, browser notes, and the optional
  Tauri path from stack.md without building it.
- Final README accuracy pass; close out progress.md.

Acceptance: harness output recorded in docs/progress.md with p95 under
budget (or a Revisit-trigger note); a folder copied to a fresh machine
plays by double-clicking `index.html` alone.

## Phase 9b: Media revision (2026-10-31, user requests)

Format flexibility for video and smarter image handling, plus the
resulting converter policy.

- Video containers: any browser-playable file is allowed - `.mp4`,
  `.webm`, `.mkv` (VP9/AV1) and `.mov`/`.m4v` are listed in the schema;
  playability is the browser's call, and the player just sets
  `<video src>`. The converter keeps browser-native sources as-is and
  transcodes only what no target browser plays (to H.264 MP4, widest
  support). Note honestly in docs: MKV playback is Chromium-class; Safari
  may refuse MKV, so converting to MP4 when the user's default browser
  needs it is the converter author's call, recorded in the build ledger.
- Short-video timing: optional `loopCount` (integer >= 1, default 1) and
  optional `holdSeconds` (> 0) on video items. `durationSeconds` stays
  required (converter fills it via ffprobe; skip-mode timing needs it).
  Machine rule: media gate = `holdSeconds` when present (time-driven
  only, `ended` ignored - the video is background); otherwise the later
  of the `loopCount`-th `ended` and `durationSeconds * loopCount` as a
  time bound; text hold always also applies. Skip dwell for a video is
  `min(skipDwell, (holdSeconds ?? durationSeconds * loopCount))`. The
  renderer plays with `loop` when `loopCount > 1` and fires
  `mediaEnded()` on the Nth `ended`; with `holdSeconds` it loops freely
  and never fires `mediaEnded` for gating.
- Image pipeline policy (converter): sniff the actual format (extensions
  lie); keep browser-compatible originals (PNG/JPEG/WebP/GIF)
  byte-identical, no re-encode, true extension in the manifest; where a
  lossless JPEG XL encode is smaller than the compatible original, ship
  `.jxl` instead. Player/schema allow `.jxl` images. Honest caveat to
  document: JXL decode requires Chrome/Edge 117+, Safari 17+, Firefox
  133+; the converter must verify an encoder exists (Pillow/libjxl or
  `cjxl`) before shipping `.jxl`, else keep the original. Naming
  conventions relax to `<id>.<ext>` where ext is the true shipped
  format; derivatives of wrapped assets follow the same
  preserve-or-JXL rule.
- Demo fixture gains a looping short video item (loopCount 2) exercising
  the new machine and renderer paths.

## Phase 9c: Video playback ranges (2026-10-31, user requests)

Allow an item to play a sub-range of a video, and let several items
share one file at different ranges.

- Fields on a video item: optional `startSeconds` (number >= 0, default
  0) and `endSeconds` (number > startSeconds, default the file's
  duration). Both stored as exact fractional seconds - the schema,
  validator, and player MUST NOT round them. `durationSeconds` stays
  the file's total duration (required, from ffprobe) and is the default
  `endSeconds`; playback duration is `endSeconds - startSeconds`.
- Timing uses the range length: media gate = `holdSeconds` if present,
  else the later of the `loopCount`-th pass-complete and
  `(endSeconds - startSeconds) * loopCount`; text hold also applies.
  Skip dwell clamps to the range length (or `holdSeconds`). A
  pass-complete means playback reached `endSeconds`: detect it per
  presented frame with `requestVideoFrameCallback` (its `mediaTime` is
  exact per frame), NOT by polling `timeupdate`, which fires only every
  ~4-250ms and so overshoots the end frame; fall back to `timeupdate`
  when rVFC is unavailable (Firefox pre-133) and say so in the docs.
  The file's true `ended` event still serves unbounded videos
  (endSeconds absent).
- Posters and stills show the frame AT `startSeconds`, including skip
  and rewind. The converter extracts the poster at `startSeconds` via
  `ffmpeg -ss <start>`. For hand-authored or test folders that cannot
  decode to seek, `poster` may equal the file (first frame) and the doc
  notes the difference.
- Playback within the range: the player seeks to `startSeconds` on
  enter, clamps to `[startSeconds, endSeconds]`, and loops from `start`
  to `end`. Because `loop=true` seeks to 0 (wrong for a range), range
  looping is done by the player seeking back to `start` on a pass
  complete - the machine counts passes exactly as in Phase 9b.
- A `text`-item chain continues the current item's video playback
  rather than restarting it: while a chain lasts, the shared video
  element keeps playing forward from where it is (within the range),
  and is NOT re-seeked to `start` on each text advance.
- Sharing: several items may reference the same `file` at different
  ranges; the validator checks the range is inside `[0, durationSeconds]`
  but does not dedup or forbid sharing.
- Range validation: validator (schema + tools) rejects `endSeconds <=
  startSeconds`, negative `startSeconds`, and `endSeconds >
  durationSeconds`; the file's real duration is checked by the converter
  (ffprobe), not the validator, which trusts `durationSeconds`.
- Frame-number authoring convenience (optional, documented): an author
  may express `startFrame`/`endFrame` at a given fps as a shorthand; it
  converts to fractional seconds (`frame / fps`) stored in the manifest.
  This is a converter/authoring aid only; the manifest field stays
  fractional seconds. The player never sees frame numbers.
- Honest boundary policy (from external review): two limits are real
  and must be measured, not assumed away. (1) Seek does not necessarily
  display the frame nearest `startSeconds` - it lands on a keyframe,
  possibly earlier. (2) Even rVFC only observes frames the browser
  presents; the last frame before a seek-back can be bounded by present
  cadence. The player therefore TESTS what is actually shown: verify
  captures the first frame displayed after entering a range and the
  last frame before loop/stop (via rVFC metadata and canvas-free
  element-state evidence, or screenshots), records the observed
  tolerances in seconds and frames in docs/verify-player.md, and the
  content-format doc states the guarantee the player actually keeps:
  playback stays inside the range and boundaries land within the
  documented tolerance. No claim of frame-exact start/end anywhere.
- Demo: convert the existing 1 s `loop-012` into a ~2 s clip and split
  it into two items over the SAME file at different ranges (e.g.
  `0.0-1.0` and `1.0-2.0`), so sharing + range + per-item poster are all
  exercised deterministically; a third item may set `holdSeconds` over a
  range. Keep the video tiny.

## Phase 9d: Loop restart point (2026-10-31, user request)

Some videos have an intro that should not repeat on loop.

- Video item gains optional `loopStartSeconds` (exact fractional
  seconds, schema minimum 0). Default = `startSeconds` (today's
  behavior). Validator cross-field: `loopStartSeconds` must be < the
  effective end (`endSeconds ?? durationSeconds`), else the loop pass
  has non-positive length. `loopStartSeconds < startSeconds` is legal
  (loop may include pre-roll the first pass skipped); `> startSeconds`
  is the common case (skip the intro on loops).
- Playback: fresh entry to the item always starts at `startSeconds`;
  after a pass completes at `endSeconds`, subsequent passes restart at
  `loopStartSeconds` (default `startSeconds`). Re-entering the item
  later starts a new first pass from `startSeconds`. Dialogue chains
  continue playback uninterrupted as before. The poster stays the frame
  at `startSeconds` (converter poster logic unchanged).
- Timing: firstPass = end - (start ?? 0); loopPass = end -
  (loopStart ?? start ?? 0); media gate = `holdSeconds` if present,
  else firstPass + (loops - 1) * loopPass (loops = loopCount ?? 1) -
  equal to range * loops when `loopStartSeconds` is absent; text hold
  and skip-dwell clamp apply as before.
- Demo: `part-013` gains `loopStartSeconds: 1.5` (range 1.0-2.0,
  loopCount 2), so the verify step measures loop-back landing near 1.5
  instead of 1.0 and re-records the observed tolerance.

## Phase 13: Author-defined branches (2026-10-31, user request)

Optional routes inside a linear story. The user's example shape (a
`branches` table with `after`, `prompt`, `routes[] {id,label,start,end}`,
`continuingRoute`, `continueAt`) is illustrative, not a mandated schema.

v1 model and decisions:

- Item `id` field: every item gains an optional stable string id (unique
  across the manifest when present). Branch references use ids, never
  array positions. Validator: ids unique; all branch references resolve;
  a route's `start` must not come after its `end` in array order; the
  route span is the contiguous inclusive range start..end (branches
  inside a decision are contiguous route sections in v1).
- `branches` is a top-level array of decisions. A decision fires when the
  LAST item of its `after` item is settled (the item before the choice).
  The lead-in (everything before `after`) and the aftermath (from
  `continueAt`) are ordinary items: they play once, not per route.
- Decision overlay: `prompt` + numbered route list (`label`). Pointer
  click or 1..9 selects; no keyboard-only requirement beyond numbers.
  Routes: 2..N allowed; more than two is required, exactly like
  Ren'Py menus.
- Route end behavior: the continuing route (exactly one,
  `continuingRoute`) proceeds to `continueAt`. Alternate routes declare
  an explicit `result`: `"return"` (after their end: overlay offers the
  still-unseen routes plus "return to main route", which goes to
  `continueAt`) or `"ending"` (their last item IS the ending; afterwards
  the overlay offers only route reselection). DEFAULT is `"ending"`:
  there is NO implicit join - an unmarked alternate route never silently
  merges, because an alternate's later state is not the main route's.
- Pure-choice decisions (no `continuingRoute`), all-played rule
  (2026-10-31, found by the extracted-demo walk): when a route of a
  decision WITHOUT `continuingRoute` completes and every route of that
  decision has now been played, the decision CLOSES and the machine
  advances to the REGION END + 1 - max(end) over all routes of that
  decision, plus one (Ren'Py fall-through: the choice blocks tile the
  menu region, and author flow after the menu continues after the
  whole region, never inside another route's span). Before every route
  has played once, the overlay reopens as before (route replay stays
  possible by returning via `e`/nav). Same rule in `Play all routes`
  and skip mode: the walk flows past instead of stalling. The old
  "at after -> after+1" micro-rule is superseded: a re-arrival at
  `after` (e.g. resume) with all routes played jumps to region end+1
  too. Documented in content-format.md.
- Nested branches: routes may contain decisions. The machine keeps a
  stack of active decision contexts; returning from a nested decision
  resumes its route. v1 supports nesting; the fixture exercises it.
  Shared endings: leaving a route's last item closes every enclosing
  frame whose route ends at that same item, each completing and taking
  its own route-end step (join, re-offer or close), so a nested
  continuing route that ends its enclosing route also completes it.
- `Play all routes` (new persisted setting, default off, in the `c`
  screen): zero interactivity. On reaching a decision, auto-pick routes
  in manifest order among routes not yet played (all seen -> pick the
  continuing route once, then past it); after a route completes, return
  to the decision and repeat until every route has played once, then
  continue via `continueAt`. `holdSeconds`/video/text timing rules
  unchanged. Works inside skip mode too. (Phase 19: the choice now
  shows with a countdown, and routes go shortest first.)
- Seen tracking (biggest machine change): a per-item visited set
  replaces the single `frontier` as the source of truth. An item counts
  seen when it is shown (same as today). Seeing a decision does NOT
  mark its routes' items seen (they are just items - true by
  construction). `e`/jumpToUnseen and skipAll target the first unseen
  item along the CURRENT path's remaining span, else the first unseen
  item of an unplayed route of the nearest open decision, else the
  global first unseen in array order; document this exactly once and
  test all three cases. Wheel/tab semantics over the array stay as
  today (clamped to seen items, except e-jump), now defined against the
  visited set rather than a contiguous frontier; the frontier becomes a
  derived value (highest contiguous seen prefix) kept for backward
  compatibility of resume.
- Persistence: PersistedState gains `visited` (item index list),
  `position` (item index + decision stack: decision id + chosen route +
  per-decision played-route ids) alongside `frontier`. Bookmarks record
  the same context; restoring a bookmark jumps to that item within that
  route context. Old states without the fields still load (visited =
  prefix up to frontier) - migration test required.
- Back/forward across decisions: navigation walks the item array (as
  today); entering the first item of a route via back/forward does not
  re-fire the decision (decisions fire only on forward SETTLE of
  `after`); backing into a decision's `after` item and pressing forward
  again re-fires the overlay. Sensible + testable; document.
- Author-written transitions: no schema mechanism needed - an author
  puts a `text`-only item or a title image at the start or end of a
  route. CREATE.md shows it.
- Deferred (documented, not built): alternate timelines with
  consequences at more than one later point (story state/variables);
  non-contiguous route sections; per-route reading state beyond
  visited items.
- Extractor: Ren'Py `menu:` -> decision table where the shape is
  conservative-detectable: each choice's block parses to a contiguous
  run of recognized items, blocks are adjacent in file order, and
  control after the last block continues in place. The LAST block (or a
  block ending in `jump`/`return` to the point after the menu) is
  `continuingRoute` when detectable, else every route defaults to
  `ending`. Detection is best-effort: when uncertain emit separate
  `ending` routes and log in the ledger; never guess a join.

## Phase 13b: Manual/auto mode clarity + key help (2026-11-01, external-user report + user clarification)

An external user asked for "a manual reading mode that waits for Space"
plus an auto-forward toggle and speed slider - implying they did not
discover that this IS the current design (manual by default; `a` starts
auto-forward; `c` screen has the reading-speed slider). README's
auto-advance bullet now names the `a` key (root cause of the
misunderstanding), and the discoverability fix is a KEY HELP overlay,
not a hint:

- A concise overlay listing every control key, rendered from the SAME
  source as the keymap module (single source of truth; test asserts
  every command appears).
- FIRST LOAD ONLY (before any advance, persisted `helpSeen` flag in
  storage): the overlay shows over a black screen; the machine is
  paused until it closes.
- ESCAPE toggles it any time: opening pauses the machine and replaces
  the screen with black (visuals hidden) + the key list; closing
  resumes exactly where it left off (same item; its hold re-arms on
  resume, like other paused overlays - documented). Uses the shared
  suspend gate with h/t/c overlays (mutual exclusion preserved).
  ESC opens only when no overlay is open; ESC closes the help overlay.
  Fullscreen caveat (documented + verify steps): when fullscreen,
  Chrome consumes the FIRST Escape to exit fullscreen and the page
  cannot reliably see that keydown; windowed-mode Escape works
  directly.
- Verify the underlying real behavior end-to-end rather than assuming
  it: manual mode is the default on a fresh load (only space/wheel/tab
  advance; nothing auto-advances until `a`); `a` toggles auto-forward
  ON and OFF; the `c` screen slider changes speed live; bookmarks,
  history (back/forward), skip, and skip-unseen behave identically in
  BOTH modes. Fix any real bug found; cover gaps in tests/verify.

## Phase 15: Minimum video play time under chains (2026-11-01, external tester)

Observed: an 8 s video followed by dialogue changed visuals at 5.829 s
- chain exit gated on text timing alone, because Phase 4 de-gates media
under text chains (`nextIsText`). Add a per-video opt-in floor:

- New optional field `minPlaySeconds` (number > 0) on video items.
  Semantics: when the CURRENT item is the last of the video's dialogue
  chain (next item is not `text`), and auto-advance governs this step
  (normal auto mode, or a play-all-routes burst - the zero-interactivity
  experience is auto), the hold is
  `max(holdMs, minPlaySeconds*1000 - chainElapsedMs)` where
  `chainElapsedMs` is the machine-time since the chain's video item
  became current (the same bookkeeping `setSettings` re-arm uses;
  deterministic ms). The chain plays through its dialogue normally
  while the video runs; only LEAVING the chain waits.
- Manual advance (space/wheel) and skip stay immediate - the floor
  exists so viewers SEE the video in auto; a reader pressing tab chose
  speed. (The first implementation also gated skip's leaving step on
  the floor; corrected - the README's "manual advance and skip stay
  immediate" is the rule.)
- `holdSeconds` interaction: `holdSeconds` remains the whole-item
  display gate for standalone videos; `minPlaySeconds` concerns chain
  exit. Both on one item: chain exit honors BOTH (max of requirements).
  Outside chains `minPlaySeconds` has no effect beyond the existing
  gate (documented; validator only checks type/positivity).
- Renderer: no change to video playback (background play already
  continues under chains); the wait is purely machine timing.
  `videoEnded`-driven completion of standalone videos unchanged.
- The field is per-video-item, not per-file: shared files may set
  different floors.
- Demo: extend the fixture with an item `stroll-025` (~6 s clip, cheap
  frames) carrying the chain's first line + 2 short dialogue items,
  `minPlaySeconds: 4.5`, placed before the branch demo so the story's
  auto-advance plays through it; verify steps 43-44: auto leaves the
  chain at ~4.5 s, not the text sum, with the dialogue advancing under
  the video, and skip through it stays immediate.

## Phase 16: Player feedback from the playable demo (2026-11-01, user)

The user played `.tmp/pkg-demo` and filed thirteen points. Grouped into
one checklist item per subsystem; these points also open the Phase 7b
deferred overlay styling.

Styling:
- All overlay text centers, dialogue and thought alike; the choice
  prompt and route rows center too.
- A thought renders pastel-blue; when a thought belongs to a named
  character the speaker name still shows (it does not today).
- Reading-speed config becomes minus button, draggable slider, plus
  button, current speed in smaller text right of the slider.

Navigation:
- One space press advances exactly one step, and one wheel tick moves
  exactly one step, forward and back. Investigate the real behavior
  first (auto-mode space may settle without moving; check wheel tick
  pixel thresholds), then make one action mean one step. Auto mode's
  own hold-then-advance is untouched.
- Scrolling (wheel) or tab-skipping onto a decision's `after` item
  SHOWS the choice overlay when the decision is unresolved, instead of
  passing it invisibly.
- Tab skip now PAUSES at a decision (shows the overlay, waits for the
  pick) instead of auto-resolving it; after a pick the player stays in
  manual mode rather than resuming the burst, so the reader is never
  swept past the start of a route they just chose; play-all-routes
  remains the no-pause path.

Branches:
- Re-picking the ending route "Turn them down" currently loops the
  same decision with no exit. Rule: once ANY route of a decision has
  completed, every re-opening of that decision offers the
  "Return to main route" option whenever a continuing route exists,
  whatever result the just-played route had. The ending-loop is
  thereby escapable.
- The seen mark on a route row means the route was PLAYED (items
  became current), not that the decision fired; scrolling back after
  taking one route must not show the other as seen.
- Play-all-routes reportedly played no branches at all on the demo:
  reproduce, fix, and make the journey legible - a flash announcement
  when a route starts ("Route: <label>") and when time jumps back to
  try another ("Back to try another route"). Without play-all,
  picking a route flashes "Route: <label>" once at entry too.
- Continuing-route semantics stay: "Late, over coffee" continues to
  the main route by design; after an ending, `e` surfaces unseen
  route content (see below). Documented in CREATE.md.

Machine bugs to reproduce and fix:
- `e` at the end of content does nothing even though route content is
  unseen; it must land on the first unseen item (routes included).
- New `e` rule (2026-11-01, user): when everything has been seen,
  `e` shows the ENDING content; with multiple endings (branches), the
  most recently seen one. Needs last-ending-touched tracking (the
  ending = the final settled item of an ending route or the array
  end), persisted with the resume context.
- Auto-forward after viewing to the end and wheeling back to the start
  stalls at the range-video item `part-012`: a navigated re-entry into
  a video must replay and complete honestly under auto mode.
- `playAllRoutes` resets to off after reload; it must persist like the
  other settings.

Second round of demo feedback (2026-11-01, user):
- Video re-watch does not replay: after passing one or more videos,
  wheeling back BEFORE them, then advancing forward again with space
  or auto, the videos no longer play (poster only). A forward
  re-entry into a video at the seen edge must play it again, exactly
  like first arrival. Root-cause against the Phase 16.9 gate change
  (`mediaGateSatisfied`) and the renderer's video play trigger: the
  likely culprit is that the play path is skipped when the cursor
  re-enters a video already below/at the edge. Ensure the renderer
  plays on any forward current-item set, independent of the gate.
- New config option "Reset progress" that clears ALL saved state for
  the content (resume position, seen/visited, played routes,
  bookmarks, settings) to restore the "first ever play" experience,
  including the first-load key-help overlay. Selecting it opens a
  confirmation box ("Are you sure? reset / cancel"); nothing is
  cleared until confirmed; cancel leaves state untouched. After
  confirming, the app behaves as a fresh profile at item 1 with help
  shown.

## Phase 17: Converter media organisation into subfolders
(2026-11-01, user)

Real games have hundreds/thousands of media files; putting them all
in one output folder is unwieldy and can choke macOS Finder. The
converter should spread extracted media across subfolders so no single
directory holds too many files.

Superseded by Phase 25: converter media now lands at
`media/<h[:2]>/<h>.<ext>`, named by the sha256 of the shipped bytes;
the `assets/` name-based buckets and `--flat` below are gone. The
subpath support (schema, validator, player, package-proof) stays.

- Bucketing by a deterministic prefix of the file name - a short hash
  prefix (or the leading chars of the file's basename) chosen so the
  same input always maps to the same subfolder. Keep it shallow
  (e.g. `media/ab/…` with a 2-char prefix = 256 buckets); the plan is
  a single flat sharding level, not a trie, unless a bucket still
  overflows.
- The content schema/validator/player must already treat `file` paths
  as relative subpaths (they do - ids map to files under `assets/`);
  confirm media `file` values may include a subfolder (`assets/ab/
  <id>.jpg`) and that the player resolves them from the folder root.
- The player's build-ledger, missing-file checks, and the
  `package-proof` "everything referenced exists" walk must follow the
  subpaths. The manifest validator's filename rule must accept an
  optional subpath while still forbidding `..`/absolute paths.
- Determinism preserved: same input -> same bucket (hash of the name,
  not a counter). The demo fixture may stay flat (small); the
  converter path is what shards.
- Update docs (content-format, extracting) and add a converter test
  asserting shard placement is stable + all referenced files exist.

## Phase 18: Second demo-feedback round (2026-11-01, user, after config reset)

- `e` gains a resume step (user point: after wheeling back, `e`
  jumped past where they had stopped reading): when the cursor is not
  at the LAST-SHOWN item, `e` goes there first (resume reading where
  you left off). From the last-shown position, `e` keeps the existing
  behavior: jump to first unseen (route-aware), repeated presses step
  unseen; all-seen still shows the most recently seen ending.
- "Return to main route" rule refined (user points: offered at a
  branch start; jumped past an unplayed continuing route; "Enter
  returns" hint shown when invalid): the option exists only once the
  decision's CONTINUING route has been completed at least once - a
  continuation you have not seen is not a place to "return" to;
  picking the continuing route is the way forward. The Enter hint
  renders only when the row exists.
- Arriving at a decision's after by navigation re-opens COMPLETED
  decisions too (seen marks, plus return row per the rule above), not
  only unresolved ones - scrolling back from the end must surface
  every decision point, nested included.
- Navigation is never trapped by a choice overlay: a wheel notch
  (either direction) closes the overlay - fired, arrival, or
  re-offer - and moves as usual. Only keys choose or dismiss.
- Skip never reveals unseen content: the skip burst advances only
  through seen items and stops ON the last seen one; from a fresh
  start tab does nothing at all. `skipAll` unchanged (it may reveal).
- Endings offer the way onward: when an ending displays and unseen
  content remains, a quiet standing hint appears ("Some content is
  still unseen - press e."); gone when everything has been seen.
- Play-all legibility: the back-in-time jump gets a dedicated
  interstitial (black screen) held ~2.5 s before the new route
  starts: the decision prompt, the route just completed, seen marks
  for every route, and the route now starting highlighted. Route
  entry pills lengthen to ~1.6 s. (Superseded in Phase 19: the choice
  screen itself shows the countdown; the interstitial is gone.)
- Demo meta pass: the fixture gains short meta text items explaining
  the intent at each demo feature (ranges, loopStart, minPlay,
  chains, the branch map - what continues, what ends, what nests,
  how to replay routes) so a first-time player can tell demo intent
  from behavior; docs list the demo's features; driver strings
  resync.

- Demo and end-to-end tests rebuilt rather than patched (user,
  2026-11-01): the old 47-step driver was one stateful sequence welded
  to the old demo's item order and text, so every demo change cascaded
  through it. The new demo is all-explanatory text, one section per
  feature; the new suite is independent scenarios on fresh profiles,
  each step of the old driver mapped to one of them.

- History rollback replaces index-order wheel walking (user,
  2026-11-01): the wheel walked seen items in array order, so after two
  routes scroll-back interleaved them in file order, and a choice screen
  was never its own step. The record of screens actually shown is now
  what the wheel replays (see docs/progress.md Phase 18). Superseded by
  Phase 27: the wheel walks the story order along the last picks.

### History rollback spec (Phase 18, user-confirmed 2026-11-01; superseded)

Superseded by Phase 27, "Timeline navigation" (user, 2026-11-03): the
wheel now walks the story order along the last pick at each decision,
`e` goes to the furthest screen read, and the reading-history record
(with its cap, Phase 26 future copy and `gap` entries) is gone; old saves
carrying it migrate automatically. Kept below as the record of what
Phases 18-26 built.

- The machine keeps a HISTORY: the ordered record of screens shown while
  reading. An entry is either an ITEM screen `{ index, stack }` (the item
  and the route frames open when it showed) or a CHOICE screen
  `{ decision, stack }` (a decision's overlay as it opened: first fire,
  route-end re-offer). A position `pos` points at the entry on screen;
  normally the last.
- Reading appends: every forward show (Space, auto, skip steps, a pick,
  the return row, a continuing route's join, play-all auto-picks) and
  every overlay open. Navigation that is not reading (`e`, a bookmark
  click, a resume landing) appends its landing too, so the record stays
  what was on screen. Phase 26 (user, 2026-11-02): when the landing's
  screen is already on record, the screens recorded after its latest
  showing are appended after the landing as its future (`pos` stays on
  the landing), so reading on replays them and `e` reaches the furthest
  point read rather than doing nothing.
  When the landing is a seen screen the record no longer holds (the cap
  dropped it, or a one-entry resume record never showed it), the
  record's end is appended again after the landing as a GAP entry: the
  furthest point read, with the screens between unrecorded. `e` goes to
  it; reading on from the landing records each screen just before it,
  so it stays the end through any picks (the record cannot tell a fork
  without the screens in between), until the reader reaches that same
  screen by reading (the gap closes), reads on from it, or jumps again
  (a new landing's gap copies the end once more). A second `e` at the
  end does nothing, as always. A `u` landing is new reading and becomes
  the end as before. The flag persists on the entry (`gap`).
- The wheel moves `pos` only: back/forward one entry, clamped to the
  record; it shows the entry exactly - an item with its stack restored,
  or the choice screen in full (the same panel, current seen marks and
  return-row rule) - and marks nothing played (Phase 22: it does put
  back that screen's played-this-pass record). A pick from a replayed
  choice screen is a real pick.
- Reading from `pos < last`: if the next screen equals the record's next
  entry, `pos` just advances (replay); otherwise the record after `pos`
  is dropped and the new screen appended (Ren'Py-style fork).
- `e` = go to the end of the history (`pos = last`), showing that entry;
  a no-op when already there. No unseen-content jumping, no ending
  lookup (the end card and `u` find unseen content; see
  docs/content-format.md).
- Persistence: the record and `pos` ride in the machine context (capped,
  oldest entries dropped first, e.g. 5000); a save without one restores
  a one-entry history at its landing.
- What stays: the seen set, played/completed routes, the return-row
  rule, skip-never-reveals (skip walks forward reading, not history),
  and bookmarks (a bookmark click is a jump that appends to the
  record). Phase 22 adds one record that does move with `pos`: the
  routes played this pass, which each entry stores and showing it puts
  back.

## Phase 19: Third demo-feedback round (2026-11-02, user)

- Play all routes shows the choice (supersedes Phase 18's back-in-time
  interstitial, user option 3): every decision, first fire and each
  re-offer, shows the real choice screen with a status line and a
  draining bar counting down for the screen's reading time at the
  reader's speed (never under 2.5 s); then the picked row is
  highlighted ~0.7 s and the route starts. Routes go shortest first
  (fewest items), the continuing route last. A re-offer leads with
  "Back in time: <route> done.". Space takes the pick at once; a digit
  or click picks another route. In a skip-all burst there is no
  countdown, only the highlight, and the burst carries on. The choice
  screens are recorded in the history; a replayed one waits, a reload
  onto the live one counts down again. Turning play-all on over a live
  choice starts its countdown; off cancels it.
- `c` works everywhere: the settings screen opens over a pending
  choice (the choice waits underneath, its digits and rows are inert,
  a play-all countdown freezes and restarts when the screen closes)
  and over the key help (`c` replaces it). Only the reset box blocks
  `c`; `t` still cannot open over a choice or the help (`t` is gone
  since Phase 35).
- Settings screen clarity: "Skip all" with an On/Off switch read as
  if turning it on starts skipping. The two skip settings now sit
  indented under a "When Tab skips" heading, as "Skip unseen content
  too" (`skipAll`) and "Play videos in full" (`skipPlaysVideos`); every
  control stays in one column. Play all routes gets a one-line note:
  "choices pick themselves after a countdown".

## Phase 20: Fourth demo-feedback round (2026-11-02, user)

- `a` counts time already shown (user option a): turning auto-forward on
  waits only for the rest of the screen's reading time, measured from
  when the screen first appeared (time under help or settings counts),
  so `a` on a screen already read moves on at once.
- Play-all choice highlight and reading time: the route play-all will
  pick is highlighted from the start of the countdown (`.choice-next`, a
  softer form of the `.choice-picked` look that takes over for the last
  0.7 s). The countdown counts every word on the screen and adds extra
  comprehension time for choice screens:
  `max(AUTO_PICK_MIN_MS, (chars * msPerChar + CHOICE_BASE_MS +
  CHOICE_PER_ROW_MS * rows) / readingSpeed)`, with `CHOICE_BASE_MS`
  1500, `CHOICE_PER_ROW_MS` 1000 and `AUTO_PICK_MIN_MS` 2500
  (`player/src/machine/choicetext.ts`). The words are the prompt, the
  status line with its "Back in time: <route> done." lead, each route
  label with its `seen` marker and the return row when drawn; the key
  hint and row numbers are left out. The audit found the old countdown
  missed the "Back in time"/"done." words, the status line and the
  `seen` markers: the demo's outer choice went from 4.5 s to 9.7 s
  (re-offer 5.6 s to 12.4 s), the nested one from 5.5 s to 10.7 s
  (re-offer 7.4 s to 14.1 s) at 1.00x.
- Auto-forward on/off message: turning auto-forward on shows a brief
  pill ("Auto-forward on"), using the same pill mechanism that shows a
  route's name on entry. Every way it turns off (`a` again, a click or
  key that stops it, Tab, a choice or the end, a panel, anything else
  in the code) shows "Auto-forward off". No pill when nothing changed.

## Phase 21: Progress that survives moving the game (2026-11-02, user)

Progress stays saved automatically in the browser (IndexedDB); these
make it independent of the folder's path and portable between browsers
and machines (user chose a and b).

- Story ID: the manifest gains a stable `storyId`. The converter derives
  it from the Ren'Py project (`config.save_directory`, else
  `config.name`, else the project folder name, slugified); the demo
  assembler and fixtures write one too. The player stores state and
  bookmarks under the story ID, falling back to the folder URL when a
  manifest has none. Progress already saved under the folder URL is
  carried over to the story ID on first load, so nobody loses it.
  Moving or renaming the folder keeps progress in that browser.
- Game name on the Esc screen: the manifest gains an optional `title`,
  shown at the top of the Esc help screen and as the page title.
  Default from the Ren'Py project (`config.name`, else the project
  folder name); the game maker overrides it with the converter option
  `--title` or by editing the manifest, and likewise the story ID with
  `--story-id`. No title, no heading.
- Export / import progress: the `c` screen gains "Export progress"
  (downloads `<storyId>-progress.json`: reading position, settings,
  help-seen, bookmarks) and "Import progress" (file picker). Import is
  for moving to another browser or machine: it checks the file is this
  story's (else a clear refusal), confirms, replaces this browser's
  state for the story, and reloads. From then on state is saved
  automatically in the browser as usual.

## Phase 22: Progress note on the settings screen (2026-11-02, user)

- The `c` screen's Progress group gets a short note saying progress
  saves in this browser automatically, and Export / Import are only for
  moving to another browser or machine.

- Rolling back restores the routes (user, 2026-11-02, option 2 "split"):
  after play-all had finished every route, wheeling back before the first
  decision and going forward skipped the choice and every route, because
  the played record never rewound and the all-played rule closed the
  decision. There are now two route records:
  - Seen routes (`played` / `completed`, cumulative, never rewound) drive
    the rows' seen marks, the return-row rule, the end card and `u`,
    exactly as Phase 18 specifies. Ren'Py also keeps chosen-menu marks
    across rollback.
  - Played this pass (`passRoutes`) rewinds with the reading position.
    Every history entry records it where it changed. The wheel, `e`, a
    resume and a bookmark restore it as of that screen; the bookmark's
    own record is used, not merged. It drives only the route flow:
    play-all's next pick (shortest not played this pass first, the
    continuing route last, never the return row), whether a route end
    re-offers, and whether a pure menu closes (the all-played rule).
  - It only grows during forward play, so within a pass play-all enters
    each route of a decision at most once and always terminates.
  - Going forward from a rolled-back position is live play. Each screen
    that matches the next recorded entry, pass record included, just
    advances the position, so a repeat run keeps the record intact. A
    wheel step forward only replays the record, and a replayed choice
    waits as before.
  - So after a rollback the repeat run is the first one again: the
    choice shows (with its countdown under play-all) and every route
    plays again. The rows keep their seen marks, and the return row
    shows once the continuing route has ever been completed. Under
    play-all the countdown counts that row like any drawn word. A
    manual reader sees which routes are seen and can pick an unseen one,
    even on a pure menu whose routes have all been seen.
  - In-story re-arrival (a route end re-offering its decision, `goTo`)
    keeps the all-played rule: only moving the reading position resets
    the pass.
  - Saves from before this record read it as their played routes, the
    old behaviour.

## Phase 23: Upgrade guide (2026-11-02, user)

- CREATE.md "Upgrading to a newer Kinetic": replace only `index.html`
  and `app.js`, validate; re-extract (same `storyId`) only for converter
  fixes or a rejected folder.

## Phase 24: Interaction-free polish (2026-11-02, user)

- No text change at the play-all pick: the status line ("picks in 1 s",
  never 0) and hint stay as at the countdown's end; only the row
  highlight changes, then the route starts.
- Play all routes on by default (an interaction-free kinetic game); a
  saved Off stays Off; Reset restores On.
- "Reading speed" is named for auto-forward ("Auto-forward speed"),
  noting it also paces play-all's countdown.
- Clicks no longer close the settings screen or the Esc help (keys do);
  `t` unchanged (gone since Phase 35). Hints say "or" in words for alternatives and use "; "
  between clauses, never "·".

## Phase 25: Reproducible, content-addressed media (2026-11-02, user + converting agent)

Source: feedback from an agent converting games (a corpus game),
forwarded by the user; survey of today's converter in that phase's
items. Decisions (user, and the converting agent where the user passed
its answers on):

- Every shipped media file is named by the sha256 of its shipped bytes,
  `media/<h[:2]>/<h>.<ext>`, posters included. `media/` is the one
  fixed folder name (user, matching the converting agent's layout).
  This replaces Phase 17's `assets/` name-based buckets and `--flat`. Not a mode or option; no backward
  compatibility or migration for old folders.
- Reproducibility is the requirement: the same game gives the same bytes
  and paths on any machine. Encoder tools are pinned: Pillow and
  imagecodecs (libjxl, replacing a system `cjxl`) in requirements.txt; a
  setup script fetches a pinned static ffmpeg per OS/arch with checksum;
  encoders run single-threaded with bitexact settings. A golden-hash
  self-test runs at setup and at converter start; on any mismatch the
  converter refuses to run, naming it.
- Images: lossless JPEG XL when it is smaller and the player shows it,
  else the original. WebP (and other pixel formats) decode to pixels,
  encode lossless, and must decode back to identical pixels. JPEG uses
  JPEG XL's JPEG recompression and must reconstruct the original JPEG
  bytes exactly. Animated images keep their animation (animated JXL only
  when verified, else the original). `.jxl` sources ship (today they are
  skipped).
- MKV videos are copied unchanged, whatever the codec. (Superseded by
  Phase 26's one video rule: an MKV no target browser plays now
  transcodes.)
- A ledger records, per output: source (loose path, or archive plus
  member), source sha256, each step with parameters, tool versions,
  output sha256. Poster recipes are recorded; a failed poster drops the
  item instead of silently using the video as its poster.
- Decoder hook `--decoder MODULE:FUNC` (shipped with the game's
  conversion package, not built into Kinetic): called with the complete
  bytes of every loose file and archive member before format detection;
  returns bytes, or `None` for unchanged; raising on recognised but
  malformed data fails loudly, never a silent skip. The ledger records
  original and decoded hashes, hook identity and its code hash.
- `kinetic-media` (separate entry point, same package): `ship` converts
  a list of sources without parsing the story, so game-specific helpers
  can delegate media; `rebuild` reproduces a folder's media from its
  ledger and the original files, verifying hashes, and exits non-zero
  on anything missing, unsupported or mismatched.
- A converter-side cache (source hash + recipe + tool versions) makes
  re-runs skip encoding.
- Several episodes become one Kinetic game: one continuous story
  (episode 2 follows episode 1) with one media folder; identical media
  is stored once.

## Phase 26: One video rule, reused media files (2026-11-02, user + converting agent)

- One video rule (user, superseding Phase 25's MKV bullet; itself
  superseded by the measured rule below): a video some target browser
  could play shipped byte-identical, anything else transcoded.
- Video playability measured, not assumed (user, 2026-11-02): files
  must play in Safari and Chrome, and there is no format restriction
  of our own. A probe page of container x codec samples
  (`.tmp/video-probe/`, decoded frames counted) ran in Safari 26.6.2 on
  an M2 and headless Chrome 156; the user agreed the rule from it.
  Video track only (the player plays videos muted). Keep byte-identical
  when both play it: H.264 in MP4/MOV/M4V/3GP; HEVC tagged `hvc1` in
  MP4/MOV/M4V; VP9 in MP4/WebM/MKV; VP8 in WebM/MKV. Remux without
  re-encoding (stream copy of the video stream into bitexact faststart
  MP4, ledger step `remux` with its `reason`, re-run by `rebuild`) when
  only the container or the HEVC tag fails: H.264, HEVC or VP9 in MKV,
  AVI, MPEG-TS, MPEG-PS, ...; `hev1` becomes `hvc1`. Re-encode to H.264
  MP4 only when the codec fails in either: AV1, MPEG-4 Part 2, MPEG-2,
  MJPEG, ProRes, H.263, Theora, FFV1, VP8 in Ogg, anything unknown. The
  container is probed (MP4 brand incl. 3GP brands, EBML DocType,
  ffprobe format), never taken from the name; the shipped extension is
  the true container's (`mp4`, `mov`, `m4v`, `3gp`, `webm`, `mkv`). The
  schema and validator accept any video extension (images keep their
  browser format list); the player never checked one.
- An existing `media/<h[:2]>/<h>.<ext>` in the output folder is verified
  and left untouched (it may be hard-linked elsewhere); one whose bytes
  do not match its name is an error naming it, never overwritten
  (kinetic-extract, `kinetic-media ship`, `kinetic-media rebuild --out`).

## Phase 27: Timeline navigation (2026-11-03, user)

Supersedes the Phase 18 history rollback spec and its Phase 26 future
copy and gap rules: a history replay took the reader along their
reading order (a bookmark visit at 2% scrolled forward back to 60%),
which the user rejected.

- The wheel walks the STORY ORDER, not a record of what was shown.
  Back from 2% goes towards 1%, forward goes past 3%; after `e` back to
  60%, back goes to 59%. Choice screens are steps of their own that
  the wheel passes through like any screen (user, 2026-11-03: scrolling
  never halts at a choice): shown with the route the walk takes
  highlighted (the `.choice-next` look), going back the route that had
  been taken, going forward the route about to be taken.
- Branches: the machine remembers the LAST PICK at each decision
  (persisted). The wheel follows the last-picked route through a
  decision, so it walks back and forth along the path last taken. With
  no known pick it takes the longest route (most items) that has seen
  content. A returning route leads back to its choice screen, and the
  walk continues past the choice along the route that continues.
  An ending route's end stops the walk.
- The wheel shows only seen screens; forward stops before an unseen
  one. It marks nothing seen or played. Reading on (Space, auto, a
  pick) from a wheeled-to screen simply continues from it: no fork, no
  replay record.
- `e` (user option a, 2026-11-03) = the furthest screen read in story
  order: the highest seen item, shown with its enclosing route frames.
  It moves only when the reader reads past it; revisiting earlier
  screens or trying another branch never moves it back. A no-op when
  already there.
- Play all routes: the played-this-pass record keeps the Phase 22
  split (seen marks stay, the pass rewinds). Wheeling back to a screen
  puts back the pass as of that point in story order: decisions after
  it (and not enclosing it) count as unplayed this pass, so reading on
  replays their choices and routes.
- Saves migrate automatically: a stored context or bookmark with the
  old reading history loses it (the record is dropped on load and not
  written again); the last pick per decision is derived from the old
  record (the latest route entered at each decision) and the current
  route frames. Seen marks, played routes, bookmarks and the current
  position are kept. No user action.

## Phase 31: Branch map (2026-11-06, user)

The route map proposal the user approved on 2026-11-01 ("a key opens the
decision tree with seen/unseen marks; clicking a decision or route jumps
there"), built now, zoomable and pannable.

- Data: only what the player already has: the manifest's `branches`
  (question, routes and labels, `result`, `continuingRoute` /
  `continueAt`, nesting) resolved exactly as the machine resolves them,
  and the reader's state in the machine (seen set, played and completed
  routes, last pick per decision, cursor, open choice). No converter or
  manifest change: existing games get it by the normal upgrade (replace
  `index.html` and `app.js`).
- Shows: each decision as a box with its question; its routes as pills
  with their labels, stacked down from the decision, each followed by its
  own line (nested decisions inside); the routes that continue or return
  meeting at a join on the decision's row, the line carrying on from
  there (at `continueAt`, or past a pure choice's menu region); ending
  routes in an end mark. Stretches without a decision collapse to one
  line with their screen count. Per reader: decisions reached (their
  `after` item seen) or not (faded, inert); each route not seen, partly
  seen (entered, or any screen seen) or played (completed, or entered
  with its last screen seen); the last pick at each decision outlined
  (the route the wheel follows, Phase 27); a "you are here" marker on the
  start dot on the story's first screen (Phase 33), on the
  stretch holding the screen shown, on an ending's (or the story's)
  end square when the screen shown is that line's last, or before the
  decision whose choice screen is up. Labels truncate; the full text and status show on hover
  or focus.
- Layout for a large game: the main line wraps into rows like lines of
  text, left to right then down. A row holds whole top-level segments
  (the stretch before a top-level decision plus that decision's whole
  subtree; a subtree is never split across rows). The row width is the
  one, of 49 tried between the widest segment and everything on one row,
  whose whole layout comes closest to the map view's aspect (the view's
  shape at the open; laid out again only when that shape changes by
  more than about 30%), so a fit fills the screen. A continuation
  connector runs from each row's last join, out right, back left through
  the gap under the row, and into the next row's first stretch with an
  arrowhead. A story with one top-level decision (the demo) stays one
  row.
- Short connectors: everything a route nests lies right of its nested
  decision's box, so the column under a tall route's pill is empty. An
  ending route (it draws no line to the join) goes on the first row under
  its decision where its pill, line and end mark clear that column,
  rather than under its tallest sibling; routes that continue or return
  still stack under everything, in manifest order, since their lines run
  to the join. When a tuck draws a decision's routes out of manifest
  order, that decision's pills (and their tooltips and aria labels) carry
  their choice numbers ("3. End the story"), so the order stays legible;
  in order, no numbers. In the demo, route 2 (an ending) now sits on the
  row right under route 1, beside the nested decision's second route.
- Opening and closing: `m`/`M` toggles it (the key table, a help row,
  and a clickable M entry on the Esc screen; to keep that screen at 12
  rows, 3 full rows of 4 or 2 of 6, with Reset in view at 800x600, the
  two decision-key rows merged into one, `1-9 0 ↑↓ Enter`, "at a
  decision: pick a route; 0 returns to main route"). Over the Esc screen it
  replaces that screen, as `t` does, so the next Esc returns to the game;
  over the bookmark list it swaps the list for the map, and `t` over the
  map swaps back. (Phase 35 removed the list and `t`: the map is the one
  screen besides the Esc screen, and the Esc screen keeps 11 rows.) It opens over a pending choice (the map moves the
  reader, like the wheel); Esc or `m` closes it. While it is open the
  machine is paused like under the other panels, and the story's keys
  and wheel are inert.
- Zoom and pan: the wheel and a trackpad pinch zoom around the pointer
  (ctrl+wheel, and Safari's gesture events); a drag pans; the arrow keys
  pan and +/- zoom; F or 0 fits the whole tree; C (and the Centre
  button) recentres on "you are here". It opens at Fit the first time
  and then where it was left (Phase 33).
  Fit fills the view less a 32 px margin, capped only by the zoom-in
  limit, and a fitted view refits when the window resizes (fullscreen
  included). Dragging never selects text. While open the map owns the
  wheel.
- Jumps use the machine's own operations: a reached decision opens its
  choice screen exactly as a wheel step onto it would (the new
  `showChoice`, which is the wheel's own screen landing, inert unless the
  decision's `after` item was seen: no marks change, the last pick
  highlighted); a route of a reached decision is entered by a real
  `choose()` from that screen (marked played, its last pick, its first
  screen seen, its route pill shown). Unreached decisions and their
  routes are drawn but inert. A jump closes the map before the route
  pill shows. No `#flash` pill is drawn over the map: opening it drops a
  pill still holding (and any queued), and none shows while it is up
  (the choice screen's pill gate, `coverChanged`).
- Scale: the layout is computed once per manifest (and view shape),
  linear in decisions and routes times nesting depth, never in items. SVG, three layers: at a readable zoom only
  the nodes and lines within half a view of the visible area exist
  (culled, redrawn when the view leaves that area); below a scale (0.6;
  0.3 for a tree of 200 nodes or fewer) labels go and the whole tree is
  drawn as one path per look; the marker stays in screen space. Measured
  with `npm run perf:map` (docs/perf.md, "Branch map").
- Spoilers (2026-11-06, user): a header switch, "Spoilers: Off" /
  "Spoilers: On" (aria-pressed, styled like the Esc screen's On/Off
  toggles), and the map-only key S (named in the button's hover title,
  Phase 33). Off by default.
  While off, the question of every decision not reached and the labels of
  all its routes (nested decisions under it are not reached either, so
  theirs too) are replaced by "Decision not reached" and "Unseen route"
  (a tucked, numbered pill keeps its number: "3. Unseen route") in the
  SVG text, the aria labels and the tooltip; the real strings are never
  put in the DOM (a hidden tooltip keeps no text). A reached decision's
  routes keep their labels, played or not: its choice screen already
  showed them. Counts, marks, status lines, layout (boxes are fixed
  sizes, never sized by their text), clicks and "you are here" are the
  same either way; a flip redraws the text only, the view unmoved. On:
  everything, as before. Stored as the `mapSpoilers` reader setting
  (`MachineSettings`, which the machine itself ignores), so it persists
  with the other settings and rides in exported progress. The rule is
  `MapMarks.hidden` (mapmodel.ts `markMap`, from `MapReader.spoilers`);
  `promptText` / `routeText` give the text the map may show.

## Phase 33: Branch map simplification (2026-11-06, user)

- Marker on the start: on the story's first screen (a first load, and
  the boot after "Reset progress", which deletes the record and reloads)
  the "you are here" point is the start dot itself (mapmodel.ts
  `hereOf`). Before, it was the first screen's place along the first
  stretch, `x0 + width * 0.5 / n`, half a stretch right of the dot when
  the first stretch is one screen (2.6 world units, about 2 to 8 px, in
  the demo's 23-screen stretch).
- Default view and memory: the first open, and any open with nothing
  remembered, is a Fit. After that the map reopens at the view it was
  left at, across closes and reloads. Stored in the story's state record
  as `PersistedState.mapView` (storage/types.ts `SavedMapView`: the
  layout signature, whether it was a Fit, the world point at the view's
  centre and the scale), beside the context and settings, so it rides in
  every state write; the map reports each painted view to the shell, and
  a close issues the write. Restore rules (mapmodel.ts `restoreView`):
  - a remembered Fit (F, the button, or the opening Fit untouched) opens
    as a fresh Fit for the window now;
  - otherwise the same world centre and scale, the scale clamped to the
    zoom limits for the window now, so the same window gives the same
    transform and another size shows the same place at the same zoom;
  - a view taken on another layout (`layoutSignature`, a hash of every
    stretch, box and pill position: another game version, or the rows
    wrapped differently for a very different window shape) opens at Fit;
  - "Reset progress" deletes the record, so the next open is a Fit.
  The marker still shows wherever it is; only C centres on it.
- Header: the title and three buttons, Spoilers (Off/On), Centre (was
  "You are here") and Fit, on one line. The hint and legend lines and
  the -, + and Close buttons are gone; the keys stay (+/- zoom, Esc or
  M close, the wheel and pinch zoom). Each button's hover title names its
  key: "shortcut: S", "shortcut: C", "shortcut: F" (0 also fits). The
  node tooltips (full text and status) stay. The map gets the freed
  height.

## Phase 35: Bookmarks on the branch map (2026-11-07, user)

The user approved prototype "B" ("cards on the line"; the shelves variant
was dropped): the bookmarks move onto the branch map, and the `t` screen
goes.

- Placement: each bookmark is a card (its thumbnail over its timestamp)
  centred on the story line at its screen's exact place, like beads on a
  string, in story order (two on one screen: oldest first). A bookmark
  inside a route sits on that route's line, nested routes included; one
  on a screen no stretch holds (between a choice's routes, say) goes at
  the end of the stretch before it, as the "you are here" marker does,
  never dropped. A stretch holding k bookmarks is as long as k cards side
  by side (`k * 290 - 10 + 28` world units) and a point along it runs
  from card to card, so the marker for a bookmarked screen is its card's
  centre; every row holding cards gets their room (101 units above the
  line, 115 below, the count line "N screens · k bookmarks" under the
  cards), the rows around it moving apart; stretches and rows without
  bookmarks keep the compact geometry (mapmodel.ts `buildMapModel`,
  `cardSlots`, `itemX`, `bandOffsets`).
- Compact structure: at 100% a world unit is a screen pixel sized by the
  cards, so a decision is a 40x22 node reading "played/total" ("?" before
  it is reached), a route a numbered pill; their full text and status are
  in the hover tooltip and aria label, where Spoilers still applies (a
  hidden route keeps its number: "2. Unseen route"). The label
  truncation helpers went with the long labels.
- Zoom: two presets with continuous zoom between them: Fit (F, or 0: the
  whole tree, cards scaled with it) and 100% (1: scale 1, a card at the
  old `t` screen's 280 px with its caption, none overlapping), zoomed
  about the view's centre. The zoom-in limit stays 3x (a compact tree in
  a big window stops there, centred). Header: Spoilers, Newest bookmark
  (N: the newest card centred at 100%; disabled with none), Centre, 100%,
  Fit, each with its instant "shortcut: …" hint. The remembered view and
  the Fit-by-default rules are Phase 33's; a change of bookmarked screens
  is a change of layout (its signature), so the next open after adding or
  deleting a bookmark is a Fit.
- Cards: the newest has the accent outline (2 screen pixels at any zoom)
  and a NEWEST tag. Below 0.7x the caption goes (the thumbnail fills the
  card) and a hover tooltip gives the time (at every zoom since Phase
  36, the time alone). A click opens the bookmark
  exactly as the `t` screen's row did (the record's context, converted
  to this manifest, through `importContext` with `mergeProgress`), closes
  the map and lands there; a press that moves 5 px is a drag and pans,
  even on a card. No key acts on a card (no Del, Backspace or Enter).
- Delete: hovering a card shows its × at every zoom, Fit included, drawn
  at a fixed screen size (24 px, down to 14 px on cards under ~80 px)
  in the card's top-right corner, with the instant "Delete this bookmark"
  hint (and no card tooltip over it). The delete is stored at once; the
  card stays as a ghost (a dashed outline at least a screen pixel wide;
  "Deleted" and an Undo button inside once the cards are big enough to
  read) until the map closes; Undo,
  a click anywhere on the ghost, the "Bookmark deleted · Undo (Z)" toast
  or Z (latest delete first) stores the record again. Storage is
  unchanged: an undo is `addBookmark` of the record read before the
  delete; no migration.
- `t`/`T` do nothing; the T row left the Esc screen (11 rows: 3 rows of
  4 or 2 of 6, Reset in view at 800x600); the M row is its only control.
  Removed: `mountBookmarkOverlay` and its CSS, `bookmarksKeyAction`, the
  list/map exclusivity, the list's README and help text. Kept in
  bookmarks.ts: the restore target, `mergeProgress`, the timestamp,
  `entryThumbSrc`, `shrinkStill`, and `cardPictures` (a card's picture:
  its capture, else the manifest still shrunk once per file per page, the
  file itself if it cannot be; the Phase 29 Safari fix), loaded a few at
  a time, the cards in or near the view first, then newest first
  (mapcards.ts `pictureOrder`).
- Rendering: the tree's SVG, the cards (HTML) and the marker live in ONE
  stage element under one CSS transform (`translate(x, y) scale(s)`, set
  once per frame), so lines and cards cannot drift apart. The prototype
  moved the card layer (its own `will-change` compositing layer, CSS
  transform) and the SVG's world group (an attribute transform, repainted)
  by separate writes; in Safari a drag sometimes moved only the cards
  until 1 then F redrew the SVG: the SVG's repaint was lost while the
  composited card layer moved on its own. With one transformed element
  there is no second layer to move; culling redraws repaint inside it.
  The view paints its own ground and isolates and clips what moves in it
  (`contain: paint`), so area the map leaves uncovered never holds stale
  pixels in Safari.
- Measured (`npm run perf:map`, 180 bookmarks over every route depth of
  the 570-decision game, docs/perf.md): opens 55-67 ms to cards painted,
  frames p95 16.7-16.8 ms. Checked by hand on a large real game (178
  bookmarks), not committed: the issues found there (a card tooltip over
  the × at Fit; a ghost at Fit a sub-pixel outline with 3 px text, its
  Undo too small to aim at) are fixed and covered by
  `bookmarkmap.scenario.mjs` with the demo.

## Phase 36: Card hover shows only the timestamp (2026-11-07, user)

- Hovering a bookmark card's picture or body shows the map tooltip at
  every zoom (Fit, 100% and between), ghosts included, with only the
  card's timestamp: `formatTimestamp`, the caption's text, on one line.
  Phase 35 showed it only below 0.7x, as "Bookmark <time>" (plus
  "(newest)") over "click to continue from here · × deletes it" (a
  ghost: "deleted · click or Z puts it back"). Over the × or a ghost's
  Undo their own hint speaks and no card tooltip shows; the tooltip's
  placement is unchanged. Undo stays with the ghost's Undo, a click on
  the ghost, the toast and Z. A card's aria label still reads "Bookmark
  <time>", with "(newest)" on the newest.
- The Esc screen's M row reads "branch map and bookmarks" (it was
  "branch map and bookmarks: click to go there").

## Phase 38: Routes that continue into the join (2026-11-07, converting agent)

A converting agent's story has one decision whose three alternatives
rejoin one long shared scene: in the source game each alternative jumps
into it. Kinetic lets only the continuing route reach `continueAt`;
every other route ends or re-offers the choice, so a reader with Play
all routes off who picks a short alternative is sent back to the choice
and must read the long continuing route to reach the shared scene.
Copying the shared scene after each route is not acceptable (duplicate
content that drifts).

- New route `result` `"continue"`: after the route's last item, flow
  proceeds to the decision's `continueAt`, as the continuing route's
  does. The validator allows it only on a decision with
  `continuingRoute`/`continueAt` (a pure choice has no join). On the
  continuing route itself it is moot, like the other results.
- Completion: stepping off a `continue` route's last item completes
  that route only. The continuing route is not completed by it, so the
  "Return to main route" row still appears only once the continuing
  route has completed (rule unchanged).
- Play all routes keeps its contract: every route of the decision plays
  once this pass, shortest first, the continuing route last, then
  `continueAt`, and the shared scene plays once. So under play-all a
  `continue` route's end behaves as a `return` route's end: it re-offers
  the choice ("Back in time: “<route>” is done.") while a route of the
  decision is unplayed this pass, and joins at `continueAt` once none
  is. The direct join, with no choice screen after the route, is what a
  reader with play-all off gets, every time.
- Passing the decision: a completed `continue` route has reached
  `continueAt`, so for `u`, the end card and every other "flow has
  passed this decision" rule it counts as the continuing route's
  completion does. Its last item is not an ending: no end card there.
- Timeline walk: a `continue` route's end leads forward to `continueAt`
  (story order, as the continuing route's does), not back to the choice
  screen. Walking back from `continueAt` takes the end of the decision's
  last-picked route when that route joins there, else the continuing
  route's end, else another joining route end that was read.
- Branch map: a `continue` route's end draws as a join into the
  decision's join point, like the continuing route's, not as a return.
- No closing-card feature: an author puts a `text` item at the route's
  end ("Later, at the office."), as for any route. Saves and bookmarks
  are unchanged: items and routes keep their ids.
- Route completion follows the route's current end. On restore, a
  completed route counts only if its `end` item is in the restored seen
  set, or flow left it past its end through a directly nested decision
  that is passed: one whose `continueAt` (or, for a pure choice, its
  menu region's fall-through) lies past the route's end, with a joining
  route completed that itself counts by this rule (inner decisions
  first), or for a pure choice every route played. Otherwise it is no
  longer completed (its played mark stays). Every completion live play
  produces survives a reload unchanged. Extending a route moves its
  `end` to a new, unseen item, so a reader who finished the shorter
  route is not offered "Return to main route" past the new content, and
  the decision is not passed until they read to the new end.

## Phase 39: The wheel steps back over unseen content (2026-11-07, user)

After a content update a back notch can do nothing. A reader who
finished a route before it was extended stands on its `continueAt`; the
story-order step back is the route's new end, which they have not seen,
so the wheel does not move (found in Phase 38; older than it). The same
dead end follows any content added behind a seen screen (a prequel, new
items inside a route) and a `u` or bookmark landing past unseen items.

- Going back, when the story-order step lands on a screen the reader
  has not seen, the wheel keeps stepping back through unseen screens
  and shows the nearest seen one. Each step back is chosen as now (the
  last pick at the decision, then the continuing route, then the plain
  step, then the first joining route) but without needing to be seen.
  With no seen screen behind, the wheel does not move.
- The last pick wins over a seen join: back from a screen that the
  decision's last-picked route joins into, the notch follows that route
  even when its end is unseen, to its last read item. So after Play all
  routes read Negotiate, Pay, then Contract, and Contract was extended,
  a back notch from the shared scene shows Contract's old end, not
  Negotiate's. Only when that route holds nothing seen do the other
  joins count.
- Forward is unchanged: the walk stops before the first unseen screen,
  where Space reads on, into the new content after an extension; `e`
  still returns to the furthest point read.
- Nothing unseen is shown or marked on the way.

## Phase 40: The Transit look and a roomier map (2026-11-08, user)

The user ran a speculative visuals pass (`.tmp/visuals`, never
committed) and chose "Scene - Transit" (`skins/s-grey-bold.css`, with
the designer's notes in `notes/s-grey-bold.md`): the Esc screen as one
contained sheet on an opaque grey, the choice screen over the blurred
story, the branch map on the same grey drawn like a transit diagram,
one gold accent, one switch, one capsule family. They compared the two
map node sizes live and chose the larger one.

- Text: the Esc screen's hint reads "Esc or Space closes" (it was "Esc
  or Space closes; click a setting to change it"). Map node tooltips
  drop their "click to ..." parts: a reached decision's status is "N of
  M routes played", and a route's drops "click to play it from its
  start" (an unreached decision's routes keep "decision not reached
  yet"). The aria labels carry the same text.
- Map layout: decisions 40x22 -> 52x28, route pills 24x18 -> 32x24,
  rows 34 -> 42, gap 20 -> 22 (`MAP_GEOMETRY`); node figures 11 -> 13 px,
  still centred in their node. Cards lose the caption strip (timestamp
  and NEWEST tag): a card is its 280x158 thumbnail, the newest keeps
  its accent outline, the hover tooltip still gives the timestamp, and
  the aria label is unchanged ("Bookmark <time>", "(newest)" on the
  newest). Rows holding cards get room for the shorter card, which
  stays centred on the line.
- Look: Transit's styles become `player/index.html`'s own, written as
  one set of rules (no override layer over the old ones), on top of
  the two changes above (no caption-strip styles, no 28-px-node
  workaround). With the user's changes to the sandbox version: key caps
  look as Transit's did before its last consistency pass (the filled,
  raised caps of `.tmp/visuals/skins-archive/scene2.css`), the choice
  numbers matching them; "Esc or Space closes" reads as plain text, not
  a capsule or button; the x of a card's delete button sits centred in
  its circle. Unchanged rules: the Esc screen hides the story (Phase
  13b); the choice screen shows the blurred story; nothing blurred,
  blended or animated inside `.map-view`; system fonts only (offline).
- Map lines: line and outline widths are screen pixels at every zoom,
  as the styles intend. In Chrome `vector-effect: non-scaling-stroke`
  does not undo the stage's CSS scale, so lines thin out at Fit and
  thicken past 100%. Far out, where rows come within a few pixels of
  each other, lines may thin with the zoom so the tree stays readable.

## Phase 41: One look at every zoom, two views (2026-11-08, user)

Zooming the branch map out past a threshold swaps its pieces: the
capsule nodes and numbered route pills become plain rectangles with no
figures, and the stretch counts go. The threshold is `labelMinScale`
(0.6x for a tree of more than 200 nodes, 0.3x for a smaller one). The
far view exists for speed: drawing every node as its own group made the
570-decision tree's later opens take 80-95 ms and its fitted view pan
at 50-80 ms frames (docs/perf.md, Phase 31), and the far view's one
path per look fixed that. The user finds the swap ugly and sees no
reason for it.

- The map's pieces look the same at every zoom: decisions and route
  pills keep their capsule shape, fill, outline, dashes, last-pick and
  reached marks, and their figures; stretches keep their counts. A
  zoomed-out view is the near view scaled down, with no change of look
  at any zoom.
- The far view may keep a cheaper way of drawing, but what it paints
  must match the near view at the same zoom. Leaving a figure or count
  out is allowed only where it would paint too small to see, so that a
  screenshot of the two drawings at that zoom shows no difference.
- Speed: opens stay within docs/perf.md's numbers for the 570-decision
  tree, and the near view's zoom frames keep Phase 40's cost. Panning
  and zooming between Fit and the old threshold need not stay fast:
  the second request below removes free zoom and pan, so Fit becomes a
  still picture.

Second request, same day: drop free zoom and pan. The map has two
views, and since neither pans freely, the fitted view no longer needs
to stay fast while moving.

- Band layout. At 100% a top-level segment of a big game is far wider
  than any screen (about 5,000 px in the 570-decision tree; a stretch
  holding 10 bookmarks is 2,900 px), so wrapping only between top-level
  segments (Phase 31, "Layout for a large game") cannot fit a width.
  The map wraps like the systems of a music score: the laid-out tree is
  cut into bands of a given width, every parallel line cut at the same
  x, and each band sits under the one before. A cut falls only where
  nothing straddles it on any line: never through a node, a pill, a
  card or a count; between two cards of a stretch is fine. A line cut
  at a band's right edge ends in a small "continues" tick, and resumes
  at the next band's left edge from a matching tick; the old
  continuation connector between rows becomes the same ticks, so there
  is one wrap mark. A band is as tall as what it holds; bands are
  `wrapGap` apart. The "you are here" marker, hit testing, tooltips,
  cards and counts follow their pieces into the bands.
- Two views, in place of free zoom and pan, chosen by one two-part
  header button, "Full size | Fit", whose pressed half is the current
  view; F switches between them (its hint "shortcut: F" on both halves).
  The 100% button and the 1 and 0 keys go.
  - Full size: cards at their 100% size, the bands as wide as the map view,
    so nothing runs off the sides. A map taller than the view scrolls up and
    down: the wheel or trackpad, the scroll bar, dragging the map (a press
    that moves 5 px is a drag, as now, so a click still opens a card or
    picks a node), and the up and down arrows, Page Up / Page Down, Home and
    End. Nothing moves sideways.
  - Fit: the bands' width and the scale are chosen together so the whole map
    is on screen at once, as large as fits, enlarging past 100% up to the
    existing 3x limit for a small map. Fit does not move: no scroll, no
    drag, the wheel does nothing. Its drawing may be optimised for a still
    picture, and opening at Fit stays within docs/perf.md's numbers with its
    counts and figures drawn (the first item left the 570-decision tree
    without bookmarks at 77-91 ms for a first open at Fit; the band layout
    added about 7 ms to every first open, from the cold cut and width
    chooser). A Full size open cuts at the view width, with no chooser.
  - No zoom other than these two: the wheel, a pinch, + and - and the
    left and right arrows no longer zoom or pan the map.
  - C (Centre) and N (Newest bookmark) switch to Full size and scroll so
    "you are here" or the newest card is in the middle of the view.
- Remembered view: the first open is Full size, scrolled so "you are here" is
  in the middle. The map remembers the last view (Full size or Fit) and, at
  Full size, where the reader left it, across closes and reloads (the shell's
  state record, as now): a scroll position if they scrolled since the last
  centring, or "centred" if their last move was C (or nothing yet), so the
  next Full size open centres on "you are here" again, wherever the reader has
  got to since. When the layout changes (a bookmark added or deleted, or the
  bookmarked screens otherwise different) a Full size open centres on "you are
  here" too. A window resize lays the bands out again for the new width: at
  Full size what was in the middle of the view stays there; Fit fits again.

## Phase 42: Even route spacing (2026-11-08, user)

The user, on a converted corpus game's map at Full size: the routes of some
decisions sit a wide gap apart and others a narrow one, even under one
decision with no bookmark inside it (route 1 to route 2 wide, route 2 to route
3 narrow), and where a band cut falls inside a decision the lines leave one
band at one set of gaps and enter the next at another, so the two halves would
not join if set side by side. The narrow gap looks better.

Cause: room for bookmark cards is reserved per row of a top-level segment,
separately in each band (mapmodel.ts `planBands`, `rowOffset`): once any card
sits on a row anywhere in a band's part of a segment, every row below it in
that part drops by a card's height, even under decisions far from the card;
and a band holding a different part of the same segment spreads its rows
differently.

- Route lines are spaced by what lies between them: a line sits one `rowH`
  below the line above it unless something that line or this one draws (a
  card, its count line, a node) overlaps it in x, and then only as far as that
  needs. A decision whose routes hold no cards, with cards on the main line
  before and after it, has all its routes `rowH` apart.
- Each line's offset is fixed once for the whole strip, before the cut, so a
  line continues at the same height in every band it crosses and the two sides
  of a cut would join edge to edge. A line is straight, so a card anywhere
  along it sets its offset along its whole length, in every band.
- Everything else stays: the look, band cuts only where every crossing is
  straight, bands sized by what they draw and `wrapGap` apart, endings tucked
  in, nothing overlapping, layout cost near Phase 41's (about 18 ms at 570
  decisions, 130 ms at 2,340).

Follow-up, same day: a straight line takes one height along its whole length,
so a card on a route in one band also lowers that route in the band before, a
gap whose reason is out of sight. The user leans to letting lines step, and
asked to compare both before choosing:

- a) One height per line, fixed for the strip (the bullets above), landed
  first: it is the groundwork for b and fixes the reported gaps.
- b) Stepped lines: each line runs at the lowest height it needs at each x,
  dropping where a card, count or node above needs the room and rising after,
  by a short S-bend in the branch curves' style; everything nested under a
  route steps with it. A cut never falls on a bend, so lines still join edge
  to edge at every cut, and no gap lacks a reason in its own band.
- The user picks between a and b on the corpus game staged with each, with
  screenshots side by side; b lands only if chosen.

The user chose a (2026-11-08). b was built and compared: it removed 60-75% of
the low-held line length on the corpus game but not all (a line stays low
after a cut until its first place to bend), its bends were steep, and dense
trees looked busier. b was dropped and is not in the code.

## Phase 43: Game apps, WebKit tests and test speed (2026-11-08, user)

A game opens by double-clicking `index.html`. The game then lands as a tab
in whichever browser window is in front, goes fullscreen only on the first
press, can drop out of fullscreen on Esc or reload, and the browser may still
show its toolbar in fullscreen. The user asked for an app-like way to play
that stays cross-platform and never meets a Gatekeeper check whose time grows
with the media. Prototypes in `.tmp/app-launch/` (2026-11-08), which the user
played on macOS and on Windows, settled the shape:

- macOS: a small app inside the game folder that shows the folder through the
  system WebKit (WKWebView, the engine Safari uses). It has its own name and
  Dock icon, starts fullscreen as a window (so Esc and reload keep
  fullscreen), and Esc belongs to the game. The app holds only its binary;
  the media stays beside it, so no check reads the media.
- Windows: a small exe inside the game folder that opens `index.html` in a
  Microsoft Edge app window (no tabs or toolbar), fullscreen from the start,
  under a profile used only by this game. Edge ships with Windows 10 and 11.
  Item 11 replaces the Edge window with the exe's own window over WebView2.
- `index.html` stays the fallback everywhere. A macOS Chrome launcher was
  built and dropped (the user, 2026-11-08): macOS gets the app or
  `index.html`, Windows the exe or `index.html`.

Facts the prototypes measured, which the items below rely on:

- Gatekeeper assesses only files that carry the quarantine flag. A folder the
  author builds locally has none, so the app opens with no check. A folder
  downloaded as a zip is quarantined. Its ad-hoc signed app is then refused,
  and App Translocation would run it away from its folder, so readers of a
  download use `index.html` (or clear the flag).
- The first time the app opens from Documents, Desktop or Downloads, macOS
  asks once for access to that folder. An ad-hoc signature changes with
  every build, so a rebuilt app asks again.
- WebKit fetches an image created off the page but decodes it only when it
  first paints, on the main thread: 106-126 ms for a 1080p JPEG XL in
  WKWebView. During a skip burst that stalled the picture at every such
  image. `img.decode()` decodes off the main thread (about 10 ms), and a
  later `<img>` with the same URL reuses the result. On one stretch of a
  converted corpus game, a 25 s Tab skip with "Play videos in full"
  off showed 97 of 275 pictures in WebKit before the change and 275 of 275
  after. Chrome went from 120 to 257 of 275.
- The scenario suite runs unchanged on WebKit through a WKWebView driver
  (`.tmp/webkit-driver/`). The driver uses an off-screen window and is
  configured the way the app configures its web view, so nothing appears on
  screen. On b196322: 325 checks, 319 pass, 3 PARTIAL (element fullscreen,
  which WKWebView has off) and 3 FAIL, all of them Chrome assumptions in the
  tests (`.tmp/webkit-driver/README.md`). The user expects some of the six to
  go with Phases 41-42.

The work, in order:

1. Test speed (the user asked for this first). The suite has got slow. Speed
   it up without losing coverage: every test and check that runs today still
   runs and can still fail. Baseline on 2026-11-08:
   - `npm test`: 5 s, 749 tests.
   - `npm run check`: 1 s.
   - pytest: 168 s, 528 tests in one process.
   - The scenario suite: about 8 min, 14 files run one after another
     (playall about 95 s, bookmarkmap 78 s, screens 76 s, branchmap 61 s).

   Candidate ways to speed it up:
   - run the scenario files side by side (each already starts its own
     profile);
   - wait for the state a check needs instead of sleeping a fixed time;
   - run pytest on several cores;
   - share expensive setup.

   Done means the same test and check counts, and the full suite passing
   twice in a row with no new flake.
2. Auto-forward after a restore. A creator session reported this, and a
   synthetic machine test with ten items reproduced it on b196322. Press `a`
   just after a reload: "Auto-forward on" shows but the restored item never
   moves until a press. README's `a` bullet promises that turning
   auto-forward on counts the time the item has already been on screen, so
   an item already read moves on at once. The cause is in machine.ts, which
   marks a restore landing `settled` and arms the hold only for an unsettled
   item, in both `setAutoAdvance(true)` and `resume()`. Two other paths hit
   the same bug: Space stopping a skip burst followed by `a`, and the Esc
   screen closing over a restored item while auto-forward is on.
   - The fix: turning auto-forward on arms the current item's remaining
     hold (from `itemShownAt`) even when the item is settled, which keeps
     README's promise. Closing a screen while auto-forward is on re-arms the
     hold fresh even when the item is settled, as it already does for an
     unsettled one ("the wait restarts from the moment of closing"). Two
     exceptions: no hold is armed while a choice is open, or when nothing
     follows the last item. The machine's interface docs for
     `setAutoAdvance` and `resume` change to match.
   - Tests and docs use only synthetic content. No game's names, paths or
     text enter the repo (the user).
   - Found while fixing it: with a pure choice whose routes run to the end
     of the item array, once every route has played the menu closes and the
     story ends on a route's last item, yet Space there steps into the next
     route's items. Space treats that point as the end of the story, as at
     the last item.
3. Decoding ahead: `render/visual.ts` `warmFile` calls `img.decode()` on each
   image it preloads (measured above).
4. Skip notices, and both modes on a choice screen.
   - Starting a skip shows the route pill "Skip on". Every stop shows "Skip
     off": Tab, Space, the last seen item, or a choice that ends the burst.
     This is the auto-forward pill's look and rule (Phase 20).
   - `a` and Tab now work on a choice screen. Each shows its pill. Nothing
     moves until the reader answers the choice the normal way. After the
     pick, the mode that is on runs from the route's first item, as if its
     key had been pressed just after the pick.
   - A burst that reaches a choice still stops there (Phase 16). Tab on that
     choice turns skip on for after the pick.
5. Esc and M on a choice screen. Dropped (the user, 2026-11-08, who may have
   misremembered). The user had reported that neither key works there, but on
   HEAD both open their screens over a pending choice, and the choice is still
   open when they close. A probe on 2026-11-08 checked the demo's outer
   decision with play-all off and with the row cursor moved, in headless
   Chrome and in the WebKit driver.
6. WebKit in the scenario suite: the driver and its puppeteer-subset adapter
   move into the repo.
   - `npm run verify -- --webkit` runs any filter on WebKit; Chrome stays the
     default.
   - The driver builds on first use from its Swift source into a gitignored
     folder, and reports a missing Swift toolchain plainly.
   - One Swift source sets up the web view for both the driver and the
     macOS app (item 7), so they cannot drift.
   - The driver fails loudly when a private WebKit hook it relies on is
     missing: occlusion off, scale override, `_simulateMouseMove:`,
     `_doAfterNextPresentationUpdate:`.
   - Rerun the full suite on WebKit first. Make engine-aware only the checks
     that still miss, each with its reason in a comment.
7. The macOS app, built when the author asks.
   - `tools/build_apps.py <game-folder> --mac` adds `<title>.app` to an
     existing game folder. `tools/assemble_folder.py` takes the same flags.
   - The app is arm64 only (Intel Macs use `index.html`), ad-hoc signed,
     macOS 12 or later. Its bundle id comes from the `storyId`, its name
     from the manifest `title`.
   - It behaves as the prototype did:
     - fullscreen from launch, and no key, Esc held or not, beeps or
       leaves fullscreen (the user, 2026-11-09);
     - ⌘Q quits, ⌘R reloads, ⌃⌘F toggles fullscreen;
     - Export saves to Downloads and Import opens a file panel;
     - progress persists across launches;
     - closing the window quits;
     - a missing `index.html` (a moved or translocated app) explains itself
       and quits.
   - Building needs a Mac with a Swift toolchain (Xcode or the Command Line
     Tools). Asking for `--mac` anywhere else fails with an error naming
     that requirement, and nothing is written.
   - `--icon IMAGE` names the icon. PNG, JPEG, WebP or JPEG XL are accepted,
     cut to a centred square. Without it, the game's first graphic is the
     icon.
8. The Windows app, built when the author asks. `--windows` adds
   `<title>.exe` to the folder.
   - It is an x86-64 GUI exe built with Go, which cross-compiles from macOS,
     Linux or Windows.
   - It behaves as the prototype did (item 11 replaces the Edge window):
     - Edge app window, fullscreen, game-only profile;
     - a second launch while open closes the game's Edge and starts it
       fresh;
     - Chrome when Edge is missing, then the default browser;
     - no console window flash.
   - Its icon comes from the same `--icon` image.
   - Building needs Go. Without it `--windows` fails with an error naming
     that requirement.
9. The game's own window controls.
   - The Esc screen gains Exit, which quits the game:
     - in the macOS app, the app;
     - in the Edge app, its window;
     - in a browser tab, the tab where the browser lets a page close itself,
       and otherwise a line asking the reader to close the tab.
   - The Esc screen gains a Fullscreen / Window toggle, and the choice is
     remembered. The window's first size is the resolution and shape of the
     game's first graphic, scaled down to fit the screen. A size the reader
     sets by resizing is kept after that.
     - In the macOS app the page asks the app over a message handler.
     - In a browser tab the toggle uses the Fullscreen API, since the click
       is the gesture.
     - In the Edge app (the user chose this over an F11 hint or a windowed
       start, 2026-11-08), the exe stays running, hidden, while the game is
       open, and steers its Edge over Edge's DevTools connection. A page
       cannot leave the window fullscreen Edge started in. The page calls a
       binding the exe added; the exe switches the window between fullscreen
       and normal and sets its size (`Browser.setWindowBounds`), and closes
       Edge on Exit. The exe ends when Edge does. The debugging port is
       local-only and lives only while the game runs. The core is tested
       against Chrome on macOS; running it on Windows is the user's check.
       Item 11 replaces this with the exe's own window.
   - The `index.html` route takes the prototype's fullscreen changes:
     - a key or click while windowed asks for fullscreen again when the
       setting is Fullscreen, and Escape never asks;
     - no request when the window already fills the screen;
     - Keyboard Lock in Chromium, so a short Esc reaches the game and only
       holding Esc leaves fullscreen.
   - One page-to-host protocol serves both apps (orchestrator's design,
     2026-11-09):
     - The host gives the page `window.kineticHost = { kind, display,
       send(message) }`: `kind` is `"mac-app"` or `"windows-app"`, and
       `display` is `"fullscreen"` or `"window"`. Whenever the object
       appears, or its `display` changes, the host fires a `kinetic-host`
       event on `window`. That includes a change the reader makes with the
       system's own controls. The object may arrive after the page loads.
     - The page sends `{ type: "quit" }` and `{ type: "display", mode }`.
     - The host owns the display mode and its memory, so an app reopens
       the way it was left with no flash. It launches in that mode. The
       first window size comes from the game's first graphic, read at
       build time and baked into the app. A size the reader sets is kept.
     - With a host present the page never asks for element fullscreen.
       With none (a browser tab), the page owns the setting, keeps it with
       the other settings, and uses the Fullscreen API.
     - The macOS side of the bridge (user script and message handler name)
       lives in the shared `WebViewSetup.swift`. The test driver therefore
       installs the same bridge with a recording host, and the scenarios
       test the page against the real Swift side.
   - Two checklist items: first the player, the macOS app and a browser
     tab; then the Edge app.
10. Testing a game with no window on screen (the user, "if possible").
    - A small library opens a built game folder in the hidden WebKit driver
      (macOS) or headless Chrome. It offers the puppeteer-style page, key
      and screenshot calls the scenarios use, plus helpers: press a key,
      read the current item, wait for an item or a choice, pick a route,
      reload.
    - It plays the folder's own `index.html` and `app.js`, so it tests what
      ships. Each open starts a fresh profile unless the creator asks to
      keep one.
    - CREATE.md documents it with a worked example. Creator sessions today
      write their own puppeteer scripts against this repo's
      `node_modules`; this replaces that.
11. The Windows exe on WebView2 (the user, 2026-11-09, after playing item
    8's exe).
    - The play check of the Edge app window found three faults:
      - Going fullscreen always showed Edge's notice ("To exit full screen,
        move mouse to top of screen"). Nothing outside Edge turns it off.
      - Holding Esc left fullscreen. This is Edge's own exit from its
        F11-style fullscreen, which the page cannot refuse.
      - The Window half did nothing until that exit. The window then came
        back at Edge's default size, likely because Edge reported its
        start-up fullscreen to the exe as a plain window.
    - The user chose to own the window. The exe opens its own window and
      shows `index.html` in it through WebView2, the Edge engine Windows
      provides to apps. Fullscreen is that window without its frame,
      covering the whole monitor it is on. WebView2 does not treat this as
      fullscreen, so there is no notice, and every key, Esc held or not, is
      the game's.
    - The page-to-host protocol is unchanged (`kind: "windows-app"`).
      - A script WebView2 runs at document creation defines the host
        object. `send` posts with `window.chrome.webview.postMessage`.
      - The exe tells the page a new mode by running script, and swaps the
        creation script so a reload starts in that mode.
    - It behaves like the macOS app:
      - It launches in the remembered mode with no flash, fullscreen the
        first time.
      - The first window is the first graphic's size, scaled to fit the
        work area. After that the reader's size and place are kept, and
        restored on that monitor while it is still connected.
      - F11 toggles the mode, as ⌃⌘F does on macOS. Exit, or closing the
        window, ends the exe. F5 and Ctrl+R reload in the same mode.
      - Export saves into Downloads, never over a file there (`name
        (2).json`), with no download bubble. Import opens Windows' file
        dialog.
      - A crashed page reloads. The window's title follows the page's, and
        its icon is the build's.
      - It shows black, with no white flash. It is sharp on high-DPI
        screens (per-monitor DPI aware).
      - No context menu, no zoom (Ctrl+wheel, Ctrl+plus), and no browser
        shortcuts beyond reload (no find, print or dev tools).
    - A second launch while the game is open brings its window forward and
      starts nothing new.
    - Progress lives in the WebView2 data folder
      `%LOCALAPPDATA%\Kinetic\WebView2\<storyId>`, with the window memory
      and `kinetic-host.log` beside it. The old Edge profile is left alone.
    - Without the WebView2 runtime, the exe opens `index.html` in the
      default browser, as a double-click would.
    - It is built from standard-library Go only (`syscall`, no cgo, no
      downloaded modules), so `build_apps.py --windows` still builds
      offline from any OS with Go. The Edge launch, the DevTools
      controller, its WebSocket client and their Chrome-based tests go.
    - `go test` covers the platform-neutral logic on any OS. The Windows
      code builds and passes `GOOS=windows go vet`. Running it on Windows
      is the user's check at the phase closer.

12. The Esc screen's balance and notices (the user, 2026-11-09, after a
    second play of the apps).
    - The play check found two faults:
      - The Settings column ran well past the bottom of the Keys card,
        and further still on Windows, whose system font sets the text
        wider.
      - After a second Export the Windows app's message line still said
        `Exported <name>.`, though the app had saved `<name> (2).json`.
        The page cannot know the saved name. The line also pushed
        everything under it down when it appeared.
    - The notices become the pill the mode pills use (Phase 20, item 4),
      shown above the Esc screen and solid there, with the pill rules
      unchanged. Both message lines go, so nothing on the screen moves
      when a notice shows. A polite status region says each notice to
      assistive tech, since the pill is hidden from it.
      - Export done says "Progress exported", with no file name.
      - An Import refusal says its existing text and holds 4 s, longer
        than a mode pill's 1.6 s. So does a failed import.
      - In a browser tab that will not close itself, Exit says "This
        browser keeps the tab open: close the tab to exit." (4 s).
    - Progress: the heading line reads "Progress · saved automatically".
      A "?" after it holds the rest of Phase 22's note: "Saved in this
      browser as you read. Export and Import carry it to another
      browser."
    - Auto-forward speed: Phase 24's note moves behind a "?" after the
      label ("Also times play-all's choice countdown."), and the cell gets
      its rounded bottom back. The - slider + row spans the cell: - on its
      left padding edge, + on its right, the slider between. The readout
      no longer sizes the column + sits in; it shares the label's line and
      takes a line of its own where both do not fit (700 px wide). It
      reads `1.00x (~60 ms/char)`, the per-character figure in
      parentheses (follow-up below).
    - Play all routes: one line like the skip switches. Its note moves
      behind a "?" after the label (follow-up below): "When on, choices
      pick themselves on a countdown." It still says what On does, so it
      reads true in either position (Phase 22).
    - Game window: the heading stays; Fullscreen | Window sits at the start
      of one line and Exit at its end, flush with the column's outer edges
      where the cards start and end.
      The rows keep their hidden labels for screen readers.
    - From 700 px wide the two columns share one width rule, so they are
      the same width (about 300 px each at 700 px, 346 at 800, 430 from
      about 1000). Their natural heights come out within about 20 px at
      1920x1080, 1280x720 and 800x600 (follow-up below).
    - Whichever column is shorter stretches to the other's end, so the
      columns end level whatever the font. A shorter Keys card's rows share
      the extra height evenly. A shorter Settings column shares it evenly
      between the gaps between its groups (each group is one element), and
      nothing inside a group moves apart. Stacked under 700 px neither
      stretches. The whole screen still fits 1280x720, 700x900 and 800x600
      with no scroll, Reset in view at 800x600.
    - Each "?" is a button named "About …" whose tip is in the DOM as its
      description (aria-describedby), never a `title`. The tip shows on
      hover and on keyboard focus, as a chip of the sheet inside the
      settings column. A click or tap pins it open, and a second one shuts
      it. A click never closes the screen, asks for fullscreen or changes a
      setting; Space and Escape still close the screen. The glyph is a
      mask drawn on the ring's own box, so its ink sits centred whatever
      the system font or engine (the user asked for this after the mock).
      The ring sits in its line as an SF Symbol sits in text: 1.5 cap
      heights across, its centre half a cap height above the baseline.
      Both come from the text's own font metrics in CSS (`cap` and `ex`
      units, with an em fallback where `cap` is missing), so they hold on
      SF, Segoe UI or any other system font, in WebKit and Chrome alike.
    - Follow-up (the user, 2026-11-09, after looking at the rebuilt apps;
      Windows looks the same as macOS):
      - The "?" ring sat too low beside its text, most visibly by
        "Auto-forward speed", and the Progress heading's ring loomed over
        its smaller text. The ring is now placed and sized from the cap
        height, as above.
      - The speed readout's dash goes: `1.00x (~60 ms/char)`.
      - Play all routes' note moves behind a "?", as above.
      - The columns were 332 and 430 px wide at 1280x720 (Keys
        `clamp(300px, 26vw, 400px)`, Settings up to 430 px). They now
        share one width. With the wider Keys rows wrapping less and the
        Play all routes note line gone, the natural heights end within
        3 px at 1920x1080, 10 px at 1280x720 and 4 px at 800x600, and the
        stretch rule above became symmetric.
    - The docs stop saying ⌘H hides the macOS app: in the real app it does
      nothing visible, and the user does not mind. The key map is
      unchanged.

Docs for items 7-12: CREATE.md (building the apps, their requirements, what
readers see, testing a game); docs/packaging.md; docs/stack.md (the
Distribution decision now includes the two apps); README.md (Exit, the
display toggle, the skip pill, the keys on a choice, the Esc screen's "?"
tips and notices); AGENTS.md (the WebKit run and whatever item 1 changes in
the test commands); docs/verify-player.md (item 12's checks).

## Phase 44: Poster check and fix (2026-11-09, converting agent)

A converting agent's game ships many videos whose items start partway
into the file. Some of their posters were made at frame 0, so the
manifest's poster is not the frame at the item's `startSeconds`, which
docs/content-format.md "Video playback ranges" requires. The player shows the
poster in skip, rewind and under text lines, so the reader sees a different
shot from the one that plays. The validator never compares a poster with its
item's start. The agent found the faults by comparing frames by hand: 144
items, 134 distinct starts in 60 files, 125 of them visibly different.
`kinetic-media ship` already makes a poster at a request's `startSeconds`
and reuses the video when re-shipping. Nothing finds the wrong posters or
writes the requests that fix them; the agent hand-writes a request file for
each shipment.

1. `kinetic-media posters <game_root> <folder> [--manifest FILE]
   [--ledger FILE] [--first-frame FILE ...] [--first-frame-all]
   [--decoder MODULE:FUNC ...] [--fix --remap FILE] [--out FILE]
   [--jobs N] [--video-jobs N]`.
   - Inputs: `--manifest` defaults to `<folder>/manifest.json` (the agent
     checks a staged manifest, which may live elsewhere and hard-link the
     folder's media). By default the folder's ledgers are read as
     `rebuild` reads them: `build-ledger.json` and/or `media-ledger.json`,
     merged by media key. `--ledger FILE` replaces that default for the
     check; `--fix` refuses (exit 2) a ledger other than the folder's own,
     since ship merges into `<folder>/media-ledger.json`. Their ledger
     holds about 113k media entries, so lookups are built once.
   - Check (the default; writes nothing): every video item, in routes too.
     The poster passes when its ledger entry (the main source or any
     `alsoFrom` source) records a `poster` step made from the same source
     sha256 as the item's video file, at the item's `startSeconds` (0 when
     the item has none). Both poster recipes, lossless and the older JPEG,
     record `startSeconds`. A recorded other start or other source fails.
     The agent confirmed (2026-11-09) that their frame-0 posters came from
     kinetic-media ship requests with `startSeconds` 0.0, so
     this ledger comparison is the whole check for them. A poster or
     video with no ledger entry, or a poster step without `startSeconds`
     (a hand-made or edited ledger), is checked by pixels instead:
     decode the poster and the frame at `startSeconds` (from the original
     source when the ledger names it, else from the folder's video file)
     and fail beyond a tolerance that a correct JPEG q90 poster, or a
     comparison against the shipped transcode, stays within.
   - Report: one line per failing item with its id, file, `startSeconds`,
     the poster's recorded `startSeconds` (or none) and a pixel difference
     (mean absolute difference per channel, 0-255), then a summary
     (checked, passed, failed, skipped). Exit 0 when nothing fails, 1 when
     anything fails, 2 when it cannot start (no manifest or ledger, media
     tools not ready, bad arguments).
   - First-frame exception: content-format.md lets a folder that cannot
     decode to seek keep first-frame posters. `--first-frame FILE`
     (repeatable, a manifest video `file`) and `--first-frame-all` skip
     those items; they count as skipped in the summary and are never
     reported or fixed. The ledger format does not change.
   - Fix (`--fix`, which needs `--remap FILE`): dedupe the failures by
     (video source sha256, `startSeconds`), make one ship request per pair
     from the ledger's source ref, and ship them into `<folder>` through
     the existing ship code: same recipe, tools, encode cache, ledger
     merge and `--decoder` hooks, so the videos are reused and only
     posters are made. Old posters stay, unreferenced, as ship leaves
     them. `--remap FILE` gets item id -> new poster (a manifest `poster`
     value) for every failing item; `--out FILE` gets the requests shipped
     (ship's `--list` format). The tool does not rewrite the manifest; the
     caller applies the remap. A failure whose video source the ledger
     cannot name is reported as not fixable, and the fix then exits 1.
     Running `--fix` again on the same manifest encodes nothing and writes
     the same ledger and remap.
2. Validator warning: `tools/validate_content.py --ledger FILE` warns, and
   does not fail, on a video item with `startSeconds > 0` whose poster's
   ledger entry records a different or missing `startSeconds` (or has no
   entry). It decodes nothing. Warnings print on their own prefixed lines
   and leave the exit code alone; without `--ledger` the output is
   unchanged.

Docs: docs/extracting.md ("kinetic-media posters" beside ship and rebuild,
and the validator option), CREATE.md ("Converting a Ren'Py project": the
check and fix as a delivery step), AGENTS.md's command list, and the
media_cli.py usage text.

## Phase 45: Poster check by item, and dark starts (2026-11-09, converting agent)

On the converting agent's published folder, Phase 44's check failed 429
items. 428 of them have posters made about 3 s into their segment, 127 of
those on items that start at 0. The agent will fix them all with `--fix`,
in a correction separate from the shipment it is delivering now. Its
delivery gate checks only the shipment being delivered. Bookmarks survive a
poster swap: they key on item, story and route ids, and only `poster`
changes. Two additions:

1. `--items FILE` limits the check, and `--fix`, to the listed item ids.
   - The file is a JSON array of strings, or one id per line (blank lines
     and lines starting with `#` ignored).
   - A listed id that is not a manifest item exits 2 and names the ids, so
     a typo cannot gate nothing.
   - A listed id that is a manifest item but not a video is ignored, so
     the file can be a shipment's full item list.
   - Items not listed are neither checked, reported, nor fixed. The
     summary says how many video items were selected out of how many.
2. Each `FAIL` line reports the mean luma (Rec. 601, 0-255) of the frame
   at the item's start and of the poster, from the frames the pixel
   difference already decodes, so no extra decoding. When the start frame
   is dark (below a measured threshold, a named constant), the line also
   says so. A dark start next to a brighter poster suggests the poster was
   moved past a black or fade-in lead-in on purpose. The agent asked this
   about the 127 start-0 items. Existing `FAIL` line fields keep their
   order; the new ones come at the end.

`--fix` stays idempotent and the remap stays as Phase 44 made it. Docs:
docs/extracting.md and CREATE.md ("Checking posters before delivery"),
the media_cli.py usage text.

## Phase 46: Large-game checks and fast saves (2026-11-09, converting agent + user)

A converting agent ran `check-game.mjs --engine webkit` on its published
game: 159,609 items, 399 routes. A full walk took 57.5 minutes and printed
every item with no error. It reported seven problems: the run never stops
at the story's end, it prints nothing for long stretches, ties between
look-alike items are hidden, there is no coverage verdict, late content
can only be reached by walking everything before it, a symlinked `media/`
fails every load on WebKit, and an undecodable picture or video passes on
Chrome.

Measured on a synthetic 160,000-item manifest with ids as long as the real
ones (28.5 characters on average), and read-only on the real manifest:

- Most of a walk step is the player's own save. On every screen change
  the player writes its whole saved context to IndexedDB, including the
  ids of every item seen (about 4.5 MB once the real game is read). On
  WebKit with 160,000 items seen a Space takes 9 ms at the median and
  49 ms at p95, over the 41 ms navigation budget (docs/stack.md); with
  1,000 seen, 1 ms and 5 ms. Chrome's profile puts the whole cost in
  `visitedSorted`, `toSaved`, `saveState` and the `put`. Readers of large
  games pay this on every Space, not just tests. A walk step (Space and
  `current()`, mean ms over 60 steps on the synthetic manifest) grows with
  the number of items seen:

  | engine | 1,000 | 40,000 | 80,000 | 120,000 | 160,000 |
  | --- | --- | --- | --- | --- | --- |
  | WebKit | 3.6 | 11.8 | 14.9 | 17.1 | 21.3 |
  | Chrome | 3.7 | 5.9 | 9.8 | 11.6 | 15.4 |

- `matchItems` costs about 3 ms per step (a scan of every item). A Map
  index gives the same hits on all 159,610 real screens in about 0.001 ms,
  after a 43 ms build.
- 29% of the real game's steps match several items after `narrowItems`.
  Each tie reads the saved place, which clones the whole saved record
  (about 30 ms at 160k seen ids). Ties settle on the first read: the
  "500 ms per tied step" in the report was inferred, not measured. A step
  past the end is about 80 ms (the save plus the read).
- At the story's end, with Play all routes on, the player shows its end
  card (`#end-card`, "You have seen everything."). A linear manifest whose
  items have all been seen shows none.
- WebKit refuses a symlink that resolves outside the game folder; a
  symlink inside it loads. The macOS app shares the test driver's web
  view setup (`WebViewSetup.load` grants read access to the folder only),
  so the app has the same limit. Chrome follows both.
- `REPORT_FAILED_LOADS` runs on WebKit only. On Chrome too, it reports an
  undecodable picture and an undecodable video (one line each, as on
  WebKit); a missing file then prints twice on Chrome (Chrome's own
  `net::ERR_FILE_NOT_FOUND` line and the reporter's).

Decisions (user, 2026-11-09): the save fix is part of this phase; the
player puts the current item's id on the page and the library reads it;
the player opens at an item named in the URL; a full walk with items never
shown exits 3.

1. Player: fast saves that still flag inserted content.
   - Every save costs about the same however much has been read. Neither
     the machine's export nor the storage write does work in proportion to
     the number of seen items on a screen change. The default design: each
     newly seen id is written as its own small record, keyed by story, and
     the main state record keeps the reader's place, open routes, played
     and completed routes and picks, with `ctx.lastShown` where the testing
     library reads it. Any other design is fine that meets both acceptance
     points.
   - Items a content update inserts into already-read content still count
     as unseen: the resume notice ("Earlier content you haven't seen -
     press u.") shows, `u` lands on them, skip stops at them and the end
     card counts them, as now.
   - Old saves load with their seen set intact and move to the new layout
     on first save; exported progress files from before still import;
     Reset progress clears everything; a story's progress stays under its
     story key (Phase 21). Bookmarks: check whether a bookmark's stored
     context needs the seen list; if not, a bookmark stops carrying it.
   - Measured: navigation on WebKit and Chrome with 100 and with 160,000
     items seen, on a synthetic manifest (reuse `mapperf.mjs`'s generator,
     ids padded to the real length), before and after, in docs/perf.md.
2. Player: the item on screen, on the page. The stage carries
   `data-item="<id>"`, the id of the item whose screen is shown (also
   under an open choice, the Esc screen and the map), updated in the same
   frame as the screen.
3. Player: open at an item from the URL. `index.html#start=<id>` opens the
   game at that item for this load, entering its enclosing routes as `u`
   does (`framesAround`: routes marked played and picked, the item seen),
   in place of the saved place. The hash is removed once applied, so a
   reload resumes the saved place. An unknown id opens the game as usual
   and logs one console warning naming it.
4. Testing library (`kinetic.mjs`, `core.mjs`).
   - `current()` takes the id from `data-item` when the stage has one.
     For a folder with an older player it matches the screen through an
     index built once per handle (same hits and order as `matchItems`,
     whose tests stay). No cache of a previous tie's answer (dropped while
     implementing: with `data-item`, fast saves and the end stop it saves
     nothing, and it could name two consecutive look-alike items as one on
     an older player). `current()` says how its id was found (player,
     screen, saved place, guess); the field name is the implementor's.
   - `openGame(folder, { startAt })` opens with `#start=<id>`; an id not
     in the manifest throws before the browser starts; a player that
     ignores the hash (the first screen is not that item) throws, naming
     why.
   - Symlinks: `openGame` looks for links in the folder that resolve
     outside it and, on either engine, logs one note naming up to three
     and the count: WebKit and the macOS app cannot read files through
     them; copy or hard-link the files.
   - Failed loads: the reporter runs on both engines; a failure Chrome
     already logged is not listed twice. A missing, an undecodable picture
     and an undecodable video each give exactly one line on each engine,
     including when the walk has moved past the item before the failure
     (an aborted load fires no error event, so files the page never
     finished loading, and posters, are checked off the page when the
     handle's `checkMedia()` is awaited).
5. check-game.mjs.
   - `--steps all` presses until the story ends; any `--steps N` also
     stops there. The story has ended when a Space changes nothing while
     the end card is shown, or at the manifest's last item. Elsewhere,
     Space changing nothing for 5 presses over at least 2 s is a stuck
     player: the run stops and fails. `--steps all` gives up, and fails,
     after twice the manifest's item count plus 1,000 presses.
   - Prints `story ended at step N` (the step that first showed the last
     screen), or `stopped after N steps`.
   - A heartbeat on stderr every 30 s: step, items seen so far, the item
     on screen.
   - Summary: items visited out of the manifest's count; for an older
     player, how many steps were named from the screen and how many of
     those were guesses; after a full walk that reached the end, up to ten
     ids never shown.
   - `--start-at ID` (through `startAt`) and `--until ID` (stops when the
     item first shows; exit 1 if the run ends without reaching it). An id
     not in the manifest exits 2.
   - Exit codes: 0; 1 for console or page errors, a game that would not
     open, a stuck player, a walk past the cap or an `--until` not
     reached; 2 for bad
     arguments; 3 when a full walk from the opening (no `--start-at`)
     reached the end with items never shown. 1 wins over 3.
6. Player: videos always fill the stage (user, 2026-11-09). A video
   sometimes plays smaller than the stage instead of filling it as its
   poster and pictures do. The trigger is unknown; scrolling back and
   pressing Space usually makes it fill. Find the trigger, reproduce it
   in a test that fails before the fix, on the engine(s) where it
   happens, and fix the cause, so a video fills the stage every time it
   plays, however it was reached (Space, the wheel, skip, a jump, a
   restore, a resize or a fullscreen change).
7. Docs: CREATE.md ("Testing your game": the quick check's new options,
   summary, exit codes, the URL start, the symlink limit for the macOS
   app; "Playing the folder" for `#start=`), docs/perf.md (item 1's
   measurements), docs/verify-player.md (the creator scenario row),
   AGENTS.md's check-game line.
8. Phase-closer: full suites; a `check-game --steps all` walk of the
   synthetic 160,000-item game on WebKit and on Chrome with the new
   player: exit 0, every item visited, `story ended at step N`, and its
   wall time beside this plan's step-time table.

## Phase 47: Audio (2026-11-09, user + converting agent)

Kinetic has had no audio (README.md, docs/stack.md, docs/packaging.md).
A converting agent asked for optional sound: music, ambience loops,
one-shot effects, and a looping sound synced to a video clip. They derive
the cues from their Ren'Py sources themselves and would hand Kinetic a
manifest. A survey of 59 corpus games (51 with audio) found the same needs
and three more:

- voice lines: 4 games, none fully voiced;
- several loops at once: 14 games reach 3 or more;
- sound inside the video files: 452 of 986 probed videos carry an audio
  stream, but only 131 are audible, the rest digital silence.

Audio files there are mostly MP3 (6,874 files in 42 games), then Ogg
(3,546 in 33), WAV (1,492 in 16) and Opus (117 in 7). kinetic-extract reads
no audio and has two faults. It turns `voice "file"` into dialogue spoken by
a character called `voice`. It rejects a menu whose choice block holds a
`play` or `stop`.

The user's decisions (2026-11-09):

- One phase: the format, the player, the validator, kinetic-media and
  kinetic-extract.
- Media rule b (item 2): keep what every engine plays, copy Vorbis and
  Opus out of Ogg into WebM without re-encoding, and re-encode the rest
  to Opus in WebM. The measurements behind the rule used a 12.000 s
  Vorbis tone made with the pinned ffmpeg, in headless Chrome 157 and
  the WebKit driver on macOS 27.2, two runs each:
  - in WebKit the Ogg file reports 12.34 s, and its clock runs 4-7%
    slower than M4A, MP3 and WebM in the same engine;
  - in Chrome it plays 0.8 s past its end;
  - the same stream copied into WebM is right in both engines;
  - the copy decodes to the same samples, and two runs give the same
    bytes.

  Safari plays Ogg only from Safari 18.4 on macOS 15.4. It plays Vorbis
  and Opus in WebM from Safari 15-17.4, inside the Safari 17 baseline
  JPEG XL already sets.
- What plays at an item follows the reader's path back (item 1). No
  item has to carry a full snapshot, and there is no per-route table.
- Controls: `v` turns sound on or off. Music, Effects and Voice volumes
  sit in a Volumes pop-out on the Esc screen, which is rebalanced
  (item 7).
- All sound pauses under the Esc screen. Music and ambience play again
  only while the Volumes pop-out is open (items 5 and 7).
- The Windows app starts sound at launch with no hint, like the Mac app,
  if WebView2 allows it (Settled list below).

Settled here, open to revisit:

- **Web Audio from script-held bytes** (changed 2026-11-11, item 16;
  until then HTMLAudioElement only). An element cannot start a sound at
  an exact moment, so its loops left a gap at every wrap and a video's
  restart click was cut, by ear in Safari, Chrome and the Mac app. Under
  file:// in Chrome, fetch fails and a media-element source outputs
  zeros, so each audio file ships as a script holding its bytes, decoded
  with `decodeAudioData` and played by buffer sources: loops are
  sample-exact, at a cost of a third more bytes and decoded PCM in memory
  (about 23 MB a minute in stereo), decoded on demand under a cap.
- **Videos stay muted.** An unmuted video may be refused autoplay and
  would stall. A video's own soundtrack plays as a separate track
  synced to it.
- **Mac app.** It keeps `mediaTypesRequiringUserActionForPlayback = []`,
  so its sound starts at launch.
- **Windows app.** It passes Chromium's
  `--autoplay-policy=no-user-gesture-required` to WebView2, so its sound
  starts at launch like the Mac app's. The flag goes in through the
  environment options' `AdditionalBrowserArguments`, or through the
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable WebView2 reads.
  Microsoft lists the flag but discourages browser flags in production
  apps. It is not verified on Windows. If WebView2 refuses a play anyway,
  the hint shows as it does in a browser.

For the converting agent, compared with their request:

- Per-item `music` and `ambience` replace `state` and `set`.
- No item needs a full snapshot. An item that sets both channels still
  pins the state, so their planned keyframes stay valid.
- `stateByRoute` is not needed: a join plays what the route read last
  left.
- Tracks carry no `kind`: the field that names a track decides its use.
- `videoSound` is `{track, duck}`.
- kinetic-media measures the durations, and it copies Ogg files into
  WebM.

1. Content format, schema and validator (docs/content-format.md, a new
   "Audio" section; docs/content-schema.json; tools/validate_content.py).
   Every field is optional, and a manifest without `audio` is unchanged.
   `schemaVersion` stays 1.
   - Top level `audio.tracks`, an object from id to track. A track has:
     - `file`: the path rule, an audio extension;
     - `durationSeconds`: required, > 0. WebKit misreports Ogg
       durations, so the player never reads the element's;
     - `startSeconds`: where a play starts (Ren'Py `<from N>`), default 0;
     - `loopStartSeconds`: where a loop restarts (`<loop N>`), default
       `startSeconds`, as a Ren'Py `<from N>` loop restarts at N;
     - `loop`: music and ambience only, default true;
     - `volume`: the author's level, 0-1, default 1.

     Several ids may share one file.
   - Per item, an optional `audio` with:
     - `music`: a track id, or null to stop. One track at a time; a
       change crossfades.
     - `ambience`: the whole set of loops from here on, an array of
       distinct ids; `[]` stops them all. A loop in both the old and the
       new set plays on unbroken.
     - `fadeMs`: the fade for this item's music and ambience changes,
       default 1000.
     - `sfx`: one-shots, `[{track, delayMs?, channel?}]`. A `channel`
       name stops the one-shot already playing on that channel, as Ren'Py's
       `play sound` does. Without one, one-shots overlap.
     - `voice`: a track id, the item's voice line.
     - `videoSound`: video items only, `{track, duck?}`. The track's time
       is the video's media time, so it follows the item's range and
       loop restart point. `duck` (0-1, default 1) scales music and
       ambience while it plays.
   - What plays at an item is resolved for music and for ambience
     separately. It is the value set by the nearest item at or before it,
     following the story back the way the reader came: through the route
     last picked at each decision, the path the wheel walks back
     (machine.ts `backwardOf`). Nothing set on the way back to item 0
     means silence.
     - A route's first item inherits from its decision's `after` item. A
       join inherits from the route read last.
     - An item that sets both channels pins the state whatever the path.
     - One-shots and voice belong to their own item and never carry over.
   - Validator rules:
     - Track files exist and pass the path rule.
     - Extensions are `.mp3 .m4a .wav .flac .webm`. Ogg (`.ogg .oga
       .opus`) is accepted with a warning: stderr, exit code unchanged,
       like the poster warning. The warning says the timing is wrong in
       WebKit, Safari needs macOS 15.4, and kinetic-media copies Ogg into
       WebM.
     - `durationSeconds` > 0, with `startSeconds` and `loopStartSeconds`
       inside it.
     - `volume` and `duck` are in [0, 1]; `fadeMs` and `delayMs` are
       >= 0.
     - Every id resolves, and ambience ids are distinct.
     - `videoSound` is only on video items. Its track is at least as long
       as the item's range end (`endSeconds`, else the video's
       `durationSeconds`), within 0.05 s.
     - An item `audio` without top-level tracks is an error. A track no
       item uses warns.
2. kinetic-media `audio` (converter ship, rebuild and ledger;
   docs/extracting.md). A request kind `audio`, with the same `source`
   forms as image and video. The probe goes by container and codec, never
   by name:
   - Keep the bytes: MP3; AAC in MP4/M4A (shipped as `.m4a`); WAV PCM;
     FLAC; Vorbis or Opus in WebM.
   - Vorbis or Opus in Ogg: copy the stream into WebM without
     re-encoding (`-map 0:a:0 -c:a copy -f webm` plus the bitexact output
     flags).
   - Anything else: re-encode to Opus in WebM at a fixed 128 kb/s.
   - Audio from a video: when the source has a video stream, ship its
     first audio stream by the same rule (AAC to M4A, Vorbis or Opus to
     WebM, MP3 as it is, else re-encoded). Loudness is measured first,
     as ffmpeg `volumedetect`'s maximum level.
     - Below a threshold, it ships nothing and the result says `silent`.
       The threshold is a named constant, measured on corpus videos:
       digital silence against the quietest audible stream.
     - A source with no audio stream says `no audio`.
     - Neither is an error, so a converter can ask for every video's
       sound.
   - `durationSeconds` comes from decoding the shipped file: samples over
     rate, 6 decimals. Container headers can be wrong for VBR MP3. A file
     that will not decode fails its request; there is never a placeholder
     (`set_video_duration`'s 1.0 is not used for audio).
   - The ledger:
     - Kind `audio`, with steps `preserve`, `remux`, `transcode` and
       `extract` carrying full parameters.
     - `alsoFrom`, the encode cache, `--jobs`, decoder hooks and
       `rebuild` work as they do for video. `run_steps` gets an
       extension per audio step; it no longer assumes `.mp4`.
   - The self-test gets samples and cases for the remux, the re-encode and
     the extract from a video. Their goldens are recorded from the
     installed pinned tools with `tools/setup_media_tools.py --repin
     CASE`, as the odd-size transcode golden was.
3. `fixtures/audio-demo`, a guided tour of sound, built by
   `fixtures/build_audio_demo.py`. It shares build_demo.py's helpers and
   makes distinct tones from the PATH ffmpeg's `sine` and `anoisesrc`. The
   builder validates its output like the demo builder, with a test in
   `tools/`. Every line of text says what the reader should hear:
   - music starting; a crossfade; a track that starts partway, with a
     loop restart point;
   - two ambience loops starting, then one stopping while the other plays
     on;
   - one-shots: a delayed one, two on one channel (the second cuts the
     first), two without a channel (they overlap);
   - voice lines on a text chain, one longer than its text, so
     auto-forward waits for it;
   - a decision whose two routes leave different music, joining at
     `continueAt`, where the music is the route read last;
   - a video with a range and a loop restart point, its synced sound
     ducking the music, with a text chain over it.

   Tracks are a mix of WebM, M4A, MP3 and WAV. fixtures/demo stays silent,
   so tests also show that a silent game has no sound controls.
4. Player: what should play, and how the cursor arrived (machine;
   Vitest).
   - render/manifest.ts parses `audio` and checks its paths like `file`.
     A manifest without it creates nothing for audio.
   - The machine exposes the target sound for the screen on show:
     - the music, a track id or none;
     - the ambience set;
     - the item's voice;
     - for a video visual, its `videoSound`.

     It is resolved as item 1 says, through the current last picks. Lift
     `backwardOf` out of the `createMachine` closure if needed. Choice
     screens, the play-all countdown and the end card keep the sound of
     the screen before them.
   - Each arrival carries a kind:
     - `read`: Space; auto-forward; a pick on a choice screen, including
       play-all's, entering the route's first item; the join or close
       reached by reading on.
     - `skip`: Tab's steps.
     - `walk`: the wheel.
     - `jump`: `e`, `u`, a bookmark, the branch map, load, reload, Import,
       Reset.

     Today `u` reports `transition` `advance` and picks report `nav`. The
     new field changes neither `transition` nor anything that reads it.
   - Speed: on a synthetic manifest of 160,000 items, 400 decisions and
     5,000 music changes, resolving takes under 1 ms per arrival (p95),
     recorded in docs/perf.md. Nothing in it delays a paint.
5. Player: playback (a new render module, main.ts wiring).
   - Elements are made on first need and reused:
     - two for music, for the crossfade;
     - one per playing ambience loop;
     - a pool of 6 for one-shots, the oldest stolen;
     - one for voice;
     - one for video sound (item 6).

     A manifest without audio makes none.
   - Volume is the track's `volume` x the reader's group volume x duck x
     fade. The groups: Music for music and ambience, Effects for
     one-shots and video sound, Voice for voice. Fades step
     `element.volume` on animation frames.
   - By arrival kind:
     - `read`: apply the target at once with the item's `fadeMs`, start
       its voice, and fire its one-shots after `delayMs`. A pending
       one-shot is dropped if the cursor leaves the item first.
     - `walk` and `jump`: once the cursor has rested 250 ms (a named
       constant), apply the target with a 250 ms fade and start the
       voice. Fire no one-shots; playing ones fade out.
     - `skip`: nothing changes while skipping. When skip stops, the item
       it stopped on is applied as after a rest.
   - Track rules:
     - Voice stops when the cursor leaves its item.
     - A music or ambience track that is still wanted plays on and is
       never restarted.
     - A non-looping music track plays once, then stays silent until the
       music changes.
   - Menus and visibility:
     - Under the Esc screen every element pauses: music, ambience, voice,
       one-shots and video sound.
     - While the Volumes pop-out (item 7) is open, music and ambience
       play. Closing it pauses them again.
     - Closing the Esc screen resumes everything that was playing.
     - Music and ambience play on under the branch map and a choice
       screen. Voice pauses under the map and resumes on close.
     - While the page is hidden, every element pauses; they resume when
       it is shown.
   - Unlock:
     - The first key or click that counts as a user activation (not Esc,
       not a Cmd/Ctrl/Alt shortcut) starts every element the game needs,
       inside that handler. Then the target applies, and the key still
       does its own job.
     - Until then, when sound is on, the manifest has audio and the
       browser refused to play, a quiet hint "Press any key for sound"
       shows. It is styled like the pills, moves nothing, and goes on the
       first gesture.
     - In a browser, nothing plays after a reload before a gesture.
     - The Mac and Windows apps allow sound with no gesture (Settled
       list), so they play at launch and show no hint. The Windows app's
       Go tests check that the flag reaches the environment it creates.
     - The WebKit driver gains a test-only option that requires a gesture
       for audio (`.audio`), so the unlock is tested in WebKit too.
   - Auto-forward waits for the item's voice line to end when the voice
     is audible: sound on, Voice above 0, unlocked. docs/content-format.md
     "Timing" says so.
   - Warm-up: the one-shots and voice of the next 3 items in story order
     get preloaded elements, capped, like the image warm-up.
   - Test hook: a hidden `#audio` element.
     - Its children are the live elements, each with `data-slot`
       (`music`, `ambience`, `sfx`, `voice` or `video`) and `data-track`.
       Tests read `paused`, `currentTime` and `volume` from them.
     - It carries `data-target` (the resolved target, as JSON) and
       `data-unlocked`.
     - `openGame` and `current()` in player/scripts/testing/kinetic.mjs
       report all this as `audio`, so a converter can check the sound per
       item with no window (CREATE.md, "Testing your game").
6. Player: video sound (render/visual.ts and the audio module).
   - It plays only while the video really plays: after its `playing`
     event, not paused, not a poster.
     - Under a text chain the clip plays on, and so does its sound.
     - During a skip with "Play videos in full", a playing video has its
       sound.
     - On posters (skip, walking back over seen content) it is silent.
   - Sync:
     - It starts at the video's `currentTime`.
     - It seeks at every range wrap (`passBoundary`) and at every native
       loop wrap, detected as `currentTime` moving back.
     - It re-seeks when it is more than 80 ms from the video. The
       constant is named and measured: the converting agent found a
       steady 16-43 ms behind, and 200-340 ms off right after a seek in
       Chrome.
   - It pauses and resumes with the video, under menus and on a hidden
     page. Chrome itself pauses a muted video in a hidden tab.
   - `duck` fades music and ambience down while it plays, and back up
     after.
7. Player: sound controls and the rebalanced Esc screen
   (render/keys.ts, config.ts, help.ts, index.html, machine/types.ts).
   - Settings: `soundOn` (default true), and `musicVolume`,
     `effectsVolume` and `voiceVolume` (0-1, default 1, steps of 0.1).
     They are saved per story and exported like the other numbers and
     booleans.
   - `v` turns sound on or off, with a "Sound on" or "Sound off" pill
     like Tab's and `a`'s.
     - In a game without audio it does nothing and shows nothing.
     - Turning sound on applies the current target, with no one-shots and
       no voice restart.
   - The Esc screen changes only when the manifest has audio:
     - The Keys card gains a `v` row, "Sound on/off".
     - Settings gains one "Sound" row: an on/off switch (the same setting
       as `v`) and a "Volumes..." button.
     - The button opens a small sheet over the Esc screen, styled and
       handled like the reset box: centred, focus kept inside, Esc closes
       the sheet alone.
     - The sheet has a `- slider +` row per volume, like auto-forward
       speed: Music, Effects, and Voice only when some item has `voice`.
     - Changes are heard at once and saved. Music and ambience play while
       the sheet is open (item 5). An Effects or Voice change plays a
       sample of at most 2 s at the new level: the last one-shot fired,
       else the game's first one-shot track; the current item's voice,
       else the game's first voice track.
   - Balance:
     - In the wide layout, the Keys card and the Settings section are the
       same width within 1 px, and their natural heights are within
       20 px. This holds at 1920x1080, 1280x720 and 800x600, for both
       fixtures/demo and fixtures/audio-demo.
     - For both, the whole screen fits without a scroll at 1280x720,
       700x900 and 800x600, with Reset in view at 800x600.
     - keys.test's check that every command has a row allows the `v` row
       to be absent in a silent game.
8. kinetic-extract reads Ren'Py audio (converter parser and timeline;
   docs/extracting.md).
   - What it reads:
     - Statements: `play`, `queue` and `stop` on `music`, `sound`,
       `audio`, `voice`, and on channels registered with
       `renpy.music.register_channel` or `renpy.audio.register_channel`.
       Their literal arguments (name, mixer, loop default) are read from
       the scripts.
     - `voice "file"`.
     - `$ renpy.music.play/queue/stop(...)` and `renpy.sound.play(...)`
       with literal arguments.
     - Clauses: `fadein`/`fadeout` become `fadeMs`; `loop`, `noloop` and
       `if_changed`; `volume` becomes the track's `volume`.
     - File names given as strings, `define audio.x = "file"` names, and
       the automatic `audio.` names (a file's base name).
     - The partial-file specs `<from N>` and `<loop N>` become a track's
       `startSeconds` and `loopStartSeconds`.
   - Mapping:
     - The `music` channel becomes music.
     - A looping play on any other channel adds that channel's loop to
       ambience, and stopping the channel removes it.
     - A non-looping play becomes a one-shot whose `channel` is the
       Ren'Py channel. On `audio`, one-shots have no channel, so they
       overlap.
     - `voice` becomes the item's voice.
     - Each cue attaches to the next item emitted. The converting agent
       derived theirs this way, matching an engine trace 99.7% / 99.8%.
     - Music and ambience changes become the item's `music` and
       `ambience` (the whole ambience set).
     - A cue after the last item is reported.
   - Not converted, each reported with its statement:
     - playlists, and `queue` beyond the first track (the first plays);
     - `<silence>`;
     - `set_volume`;
     - expressions and variables naming a file;
     - creator-defined statements;
     - audio inside screens, ATL, and Python other than the literal calls
       above;
     - a voice file that is missing (its cue is dropped).
   - Fixes:
     - `voice "file"` no longer becomes dialogue.
     - Audio statements inside a choice block no longer reject the menu;
       they attach to the route's first item.
9. kinetic-extract ships the sound (converter assets; fixtures/renpy_demo).
   - Every audio file a cue names ships through item 2's `audio` kind into
     `media/` and the ledger, loose or from `.rpa`.
   - `audio.tracks` gets one id per distinct file, `startSeconds`,
     `loopStartSeconds` and `volume`, with the measured duration.
   - Each video item's file is also requested as `audio`. An audible
     soundtrack becomes the item's `videoSound` (`duck` 1). Silent and
     absent ones are skipped and counted in the summary.
   - fixtures/renpy_demo gains music, an ambience loop, a one-shot, a voice
     line, an audio statement inside a menu choice, and a movie with an
     audible soundtrack. generate_assets.py keeps `-an` for every other
     video. The golden manifest is updated.
10. Docs:
    - README: sound under Content, `v` under Playing, the Volumes pop-out
      on the Esc screen, the audio demo under The demo; "Audio" leaves
      Not supported.
    - docs/stack.md: the requirements line; why videos stay muted; an
      audio decision covering formats, HTMLAudioElement, the file:// facts
      and the app hosts.
    - docs/packaging.md.
    - CREATE.md: sound in a hand-written folder; audio in kinetic-extract
      and in kinetic-media ship lists; the `audio` state in "Testing your
      game"; the note that a remuxed video has no audio track points to
      video soundtracks.
    - docs/verify-player.md: the audio scenario rows, and a manual
      listening checklist that walks fixtures/audio-demo step by step,
      saying what to hear.
    - AGENTS.md's command list.
    - apps/README.md: both apps play sound at launch, the Windows app
      through the autoplay flag.
    - docs/perf.md: navigation p95 with audio, on the audio demo and on
      item 4's large synthetic manifest, within 41 ms.
11. The user runs the listening checklist once, on fixtures/audio-demo, in
    real Safari, desktop Chrome and a Mac app built for it. Agents cannot
    hear. What the user reports becomes fixes before the phase closes.
12. Silent automated runs (added 2026-11-10, done after item 5). The user
    heard the item 5 and 6 scenarios play the demo's tones aloud. Every
    browser the tools launch makes no sound: the scenario runner, the
    smoke check, the testing library (`openGame`, check-game.mjs),
    package-proof and the perf and timing scripts, in Chrome and in the
    WebKit driver. The Mac and Windows apps are unchanged.
    - Playback goes on as before: elements play, `currentTime` advances,
      and `playing` and `ended` fire, so the audio checks still read
      `current().audio` the same way.
    - The gesture rule stays real: Chrome still refuses a play before a
      key, and so does the WebKit driver with
      `--require-gesture-for-audio`.
    - Preferred: the engine opens no audio output at all (in Chrome a
      fake output stream, `--disable-audio-output`), checked by whether
      the process opens a Core Audio output. Muting is the fallback where
      that is not possible, and the report says which each engine got.
    - Probes use digitally silent files, so a mechanism that fails is
      still not heard.
13. No argument spread over a story-sized list (added 2026-11-10, found
    measuring item 10). A spread into a call, such as
    `Math.max(...items.map(...))`, passes one argument per element, and
    Chrome throws past about 120,000. render/audio.ts did this for its
    ambience cap, so a 160,000-item game never answered a key, and
    storage/ids.ts does it over the seen set when a saved place no longer
    exists. Both become loops, and a sweep of player/src finds any other
    spread over a list that grows with the story.
14. Ambience loops play on (added 2026-11-10, the user's listening check,
    item 11, the same in Safari, Chrome and the Mac app). On the demo's
    `amb-start` the rain stopped after one play while the hum restarted
    with gaps, and `amb-carry` had no rain at all. An ambience or music
    loop plays on unbroken for as long as it is wanted: a native loop
    (start and loop start 0) wraps with no pause beyond the engine's own
    seam, a loop that restarts elsewhere wraps within one animation
    frame, and nothing else pauses, seeks or restarts a wanted loop.
15. Video sound clicks stay on the wall hits (added 2026-11-10, the user's
    listening check, all three engines): on `video-sync` the clicks were
    usually on the bar's wall hits but sometimes not. The video sound
    neither skips nor doubles a click and stays within the sync bound
    through the wraps, the text chain and the menus, including the re-seeks
    themselves.
16. A trial of two sound routes (added 2026-11-11, the user's choice after
    re-listening to items 14 and 15). An HTMLAudioElement cannot start a
    sound at an exact moment, so loops keep a gap at each wrap and the click
    on a video's restart point is cut or lost on real output. Before items
    14 and 15 are fixed again, scratch pages on the demo's tracks try:
    - Web Audio fed from a track's bytes in a script file (no fetch, no
      media-element source, both of which fail under file:// in Chrome):
      sample-exact loops, and the video sound on the audio clock;
    - the video playing its own soundtrack, unmuted after the first key,
      and element loops crossfaded at the seam.

    Each is measured from the samples it produces (seam gaps, click onsets
    against video frames), in Chrome and WebKit, with which formats each
    engine's Web Audio decodes and whether the decode pads a loop. The user
    listens to both in Safari and Chrome; the route chosen then becomes the
    fix for items 14 and 15, and the Settled list changes if it is Web
    Audio.

    The user chose Web Audio (2026-11-11). The trial measured buffer loops
    bit-exact in Chrome and WebKit, every click of the video sound present
    at full level, 24 ms early to 48 ms late against the frames, and
    `decodeAudioData` exact at the start for AAC (M4A), Vorbis in WebM,
    WAV, FLAC and Opus in Ogg, with MP3 (WebKit +576 samples), Opus in
    WebM (Chrome -24) and Vorbis in Ogg (WebKit -128) not. Items 17-20
    carry it out; items 14 and 15 close when they pass and the user has
    listened again.
17. Audio files ship as scripts (format, kinetic-media, kinetic-extract,
    the validator, the fixture builders, assemble_folder).
    - A track's `file` still names the audio file. Beside it the folder
      ships `<file>.js`, a script that hands the player the file's bytes
      (base64) through one global function the player defines; the exact
      shape is set here and documented in docs/content-format.md "Audio".
      The player reads only the script.
    - kinetic-media's `audio` kind, kinetic-extract and
      fixtures/build_audio_demo.py write the script beside each shipped
      audio file, deterministically; the ledger and `rebuild` cover it.
      `tools/assemble_folder.py` writes a missing script for a
      hand-written folder's tracks. Until item 19 the audio file still
      ships too (the video's sound plays from an element until then);
      from item 19 the assembled folder ships only the scripts.
    - Loop-safe formats: a track that loops (music, ambience, a video's
      sound) ships only in a format `decodeAudioData` decodes with no
      lead change in Chrome and WebKit (AAC, Vorbis in WebM, WAV, FLAC,
      Opus in Ogg as measured). A kinetic-media request says it loops,
      and such a source in MP3, Opus in WebM or Vorbis in Ogg is remuxed
      (Vorbis into WebM) or re-encoded to a loop-safe format, with a new
      self-test golden. The validator warns on a looping track in an
      unsafe format. The audio demo's loops move to safe formats.
18. Player: sound on Web Audio (render/audio.ts and audiorules.ts).
    - One AudioContext, resumed inside the first key that unlocks sound
      (the hint and the rules of item 5 stay). Tracks load by adding
      their script, decode with `decodeAudioData`, and stay decoded in an
      LRU under a byte cap (a named constant, measured), the next items'
      tracks decoded ahead as the warm-up.
    - Music and ambience: buffer sources with `loop`, `loopStart` and
      `loopEnd` from the track, so every wrap is sample-exact; one-shots
      and voice: buffer sources. Volume, fades and the duck are gain
      AudioParams. Item 14's element trade, lead learning and output-grid
      timing go.
    - Every pause rule of items 5 and 7 holds (Esc, the Volumes sheet, the
      map, a hidden page), with a paused source resuming where it
      stopped.
    - The `#audio` hook and `current().audio` keep their shape (slot,
      track, paused, currentTime, volume per playing sound; target;
      unlocked), computed from the engine.
    - Automated runs stay silent: Chrome's fake output covers Web Audio;
      for the WebKit driver it is measured whether the page mute does,
      and if not the testing launchers set a test-only master mute.
    - Tests: item 14's checks (loops play on with no gap) read from a
      test-only tap of the mix in both engines, as the trial measured.
19. Player: a video's sound on the audio clock (render/audio.ts,
    render/visual.ts). The sound is the master: its buffer loops the
    video's range (`loopStart` at the restart point, `loopEnd` at the
    range end), and the video follows it, sought ahead of each wrap and on
    drift. Item 15's checks (no click skipped or doubled across ten wraps,
    every click within 80 ms of its wall hit) read from the tap. The
    element trade of item 15 goes.
20. Docs and speed: docs/stack.md's audio decision, docs/packaging.md
    (sizes with scripts), CREATE.md and docs/extracting.md (scripts,
    loop-safe formats), docs/verify-player.md (the checklist unchanged
    unless a step's sound changes), docs/perf.md (navigation p95 with
    Web Audio on the audio demo and the 160,000-item story, decode time
    and memory against the cap).
21. A measurement of WebKit's decode time (added 2026-11-13, the user's
    choice). After item 18, a 3-minute stereo AAC track takes about 3.7 s
    to decode in the WebKit driver against 0.2 s in headless Chrome, so a
    jump to a scene whose long track is not warmed up starts it that late
    in Safari and the Mac app. Scratch pages time each stage (script load,
    base64 to bytes, `decodeAudioData`) and whether the page stalls while
    it runs. They compare format, sample rate, channels and length, the
    context's own sample rate, and decoding a track in pieces that join
    sample-exactly. The outcome says whether a converter or player choice
    brings such a start under 0.5 s; the user then picks the fix, if
    any. Until then a late start after a jump is a known limit.

    Measured 2026-11-13: WebKit's AAC decode is slow only at the file's
    own sample rate (a 3-minute stereo track 3.5-4.2 s, growing with the
    square of the length) and takes 120-200 ms at any other rate; FLAC,
    WAV, MP3, Opus and Vorbis are not affected. The page does not stall,
    but WebKit decodes one file at a time per context, so a short sound
    waits behind a long track. The user chose the player fix (item 22).
22. Player: fast AAC decodes in WebKit (render/audio.ts; added
    2026-11-13, the user's choice after item 21). Where the engine is
    WebKit (Safari, the Mac app's WKWebView, the WebKit driver), an AAC
    track whose own rate (read from its header) is the context's rate
    decodes on an OfflineAudioContext at twice the context's rate, and
    every second sample is kept in a buffer at the context's rate. Any
    other AAC already decodes fast at the context's rate and does so as
    usual: at twice the rate a resampled length can come out one short,
    and keeping every second sample of a file above the context's rate
    would fold its top octave into the band (found in the item,
    2026-11-13). In WebKit each file decodes on its own
    OfflineAudioContext, so no decode waits behind another. Chrome,
    WebView2 and Firefox decode as now. The kept buffer starts on the
    same sample as the usual decode and has the same length; loops and
    wraps are unchanged. The decode cache's notes and cap are revisited
    against the new times.
    - Tests: Vitest for the sample keeping (start, length, every second
      sample, each channel) and for the choice of decode by engine,
      format and rate; in WebKit a 3-minute stereo 48 kHz AAC ready
      within 0.5 s of the request, and a short sound asked for during
      its decode ready within 0.1 s; item 14's loop checks still passing
      from the tap in both engines.

Not verified, and not verifiable on this machine: WebM Vorbis and Opus in
Safari 15-17 (caniuse and WebKit bug 183852 say yes), WebView2's autoplay,
and Firefox.

## Phase 48: check-game follow-ups (2026-11-14, converting agent + user)

The converting agent ran Phase 46's check-game on its 186,268-item game
(544 routes, 60,924 media references). A full `--steps all` walk took
about 15 minutes on either engine and passed, but the media check after
it printed nothing for 23.7 minutes on Chrome and about 11.5 on WebKit.
They sent ten points. Measured on their folder, read-only (2026-11-10):

- The media check decodes each file the walk did not see load (`new
  Image()` plus `decode()`, 4 at a time in the walking page). One Chrome
  page decodes one at a time: 19-20 ms a file at 4, 8, 16 or 32 at once,
  1.6 ms without the decode. Pages in separate browser contexts add up: 2
  pages 11.7 ms a file, 4 pages 5.9, 6 pages 5.8. WebKit decodes in
  parallel in one page: 8.5 ms a file at 4, 6.7 at 8, 6.5 at 16-32.
- Checking during the walk is slower: a Chrome walk went from 2.6 to 9.4
  ms a step with 4 checking contexts beside it (8 cores).
- Over a full walk the page was given 60,916 of the 60,924 referenced
  files. The 8 it never got are animation frames after the first, which
  a fast walk never cycles to. The agent's "about 800 never requested" read
  `checking 60,122 media files the walk passed` as every file checked; it
  counts only the files left unconfirmed after the walk.
- A walk from `--start-at route1-start` to `--until after-start` on the
  demo shows 6 items. The manifest-order span between them also holds
  route2's two items, which play-all never shows from inside route 1 (the
  continuing route goes on to `continueAt`).
- The validator accepts an item in no route between a decision's last
  route end and its `continueAt`; only a walk finds it (exit 3).

Decisions (user, 2026-11-10): check media in parallel after the walk, with
progress and a skip option; the `--until` span leaves out the other routes
of each decision the start item lies inside; a symlink out of the folder
fails on both engines; an older player refusing `--start-at` keeps exit 1,
documented.

1. Media check: parallel, with progress, skippable. After the walk, on
   Chrome several pages in separate browser contexts (4 measured best), on
   WebKit 8 checks at a time in the page. Every 30 s a stderr line says how
   many files are checked out of how many. `--no-media-check` skips it and
   the summary says media were not checked; the exit code then comes from
   the walk and the console only.
2. Media check covers every file a walked item references: files the page
   was never given (animation frames after the first, and any other kind,
   audio included) are checked too. The summary says how many files loaded
   during the walk, how many were checked after it, and how many of those
   the player never requested; the stderr line before the check says its
   number is the files left to check.
3. Failed loads say why, the same on both engines: `(not found)` when the
   file is not on disk, `(could not decode)` when it is; Chrome's own line
   for a missing file is merged as now.
4. `--until`: implies `--steps all` unless `--steps` is given. When the
   walk reaches the `--until` item it reports the span from the start (the
   opening or `--start-at`) to that item: items in manifest order, leaving
   out the other routes of each decision the start item lies inside. The
   summary says how many of the span's items were shown and lists up to ten
   that were not; exit 3 when any were not (1 still wins).
5. A symbolic link in the folder that resolves outside it fails the run on
   both engines (exit 1), naming the links, as the note does now.
6. Validator: warn, on stderr with the exit code unchanged (as the poster
   warnings do), on items no walk can reach. At least an item inside a
   decision's region (after its `after` item, before its `continueAt`) in
   none of its routes; pure choices and nested routes follow the machine's
   rules (player/src/machine/machine.ts). On generated manifests the warned
   items must equal the items the machine's play-all walk never shows.
7. Docs: CREATE.md (an older player refusing `--start-at` exits 1, beside
   the option; a seeded `ctx.visited` list is merged into the seen records,
   so seeding twice in one profile adds up, and how to start clean; the
   media check's progress, coverage, wording and skip option; the `--until`
   span and exit 3; the symlink failure; the validator warning),
   AGENTS.md's check-game line, docs/verify-player.md rows,
   docs/extracting.md or wherever the validator's warnings are listed.
8. Phase-closer: full suites; a timed `check-game --steps all` walk, media
   check included, of a 160,000-item synthetic game on both engines.

## Phase 49: Video segments (2026-11-14, converting agent + user)

A converting agent's game has hundreds of videos that are one file
holding several camera views joined by smooth camera moves. The original
game knew each view's times, played the views in turn under the dialogue,
and let the reader jump to the next or previous view with arrow buttons.
In Kinetic a reader who presses Space after the last line under such a
video leaves the whole video. The agent asked for an optional list of
views on a video item, so that Space, after the lines, steps through the
views before leaving. They would mark 467 items.

Checked on their data, read-only (2026-11-13): files hold 2 to 6 views;
each view's end is the same number as the next view's start in the
original timing files (values such as `81.03999999999999` included), so
copied as they are, adjacent segments touch exactly; no view ends past
the item's `durationSeconds`. One file's third view has its loop start
(35) before the end of its camera move (35.2), which is also where the
second view ends: a segment starting at the loop start would overlap the
one before. Every marked item loops the whole file from 0 under its lines
(`loopStartSeconds` 0, below `startSeconds`), and many start at a later
view, so by the last line the video can be anywhere in the file. 166 of
the items have no lines after them.

Today's code: Space reaches `machine.advance()` (player/src/machine/
machine.ts), whose branches run in order: an auto-pick, an open choice,
skip playing a video, skip, auto-forward, and last the manual step, which
settles the item and calls `moveForward()` (the decision, a route end,
the story end, else the next item). The renderer (player/src/render/
visual.ts) plays an item's range from a per-item plan (`videoPlanFor`,
`passBoundary`, `seekTo`), and the video's sound follows the stage's pass
(`StageVideo.pass()`, render/audio.ts `followPass`) and restarts where
the video is after a seek (Phase 47 item 19). check-game (player/scripts/
testing/walk.mjs) calls a Space that changes nothing 5 times in 2 s a
stuck player, and one at the last item or end card the story's end.

The user's decisions (2026-11-13):

- After Phase 48, as its own phase.
- The two extras the agent called optional are in: Left and Right step to
  the previous and next segment, and each step shows a short note.
- The validator compares exactly (no tolerance), as it does for ranges;
  segments may touch.

The orchestrator's choices, within the request: the arrow keys work only
where Space steps segments (the chain's last item), as rule 2 below
places Space's step, so "lines first" holds for every key; the note reads
"View n of m", n counting from 1 in the item's segment list.

1. Format, schema and validator. Video items may carry `segments`: a
   non-empty array of `{startSeconds, loopStartSeconds?, endSeconds}`,
   no other keys, and no other item type may carry it. Each
   `startSeconds` is at least 0; `endSeconds` is greater than
   `startSeconds` and at most `durationSeconds`; `loopStartSeconds`
   (default `startSeconds`) is at least 0 and less than `endSeconds`
   (below `startSeconds` is legal, as for an item); each segment starts
   at or after the end of the one before (touching allowed). Exact
   comparison, nothing rounded. Segments may lie outside the item's own
   range. docs/content-format.md gets "Video segments" with the rules of
   items 2 and 3, and the list of what ignores the field: the item's
   range, poster, media gate, auto-forward, skip, the wheel, bookmarks,
   seen marks, the branch map, reload and re-entry (which start at the
   item's `startSeconds` as now), and the validator's reachability walk.
2. Machine: Space steps segments. Only in the manual branch of
   `advance()`, before `moveForward()`: when the cursor is the last item
   of its chain (the video item itself when no `text` follows), its
   visual item is a video with `segments`, and the stage plays that
   video (one a menu holds paused counts; a poster held on a `nav`
   arrival below the seen edge does not), the press makes the
   first segment that starts after the video's current time the active
   segment, and later presses step to the next one by index (never by
   re-reading the time: a seek can land a hair before its target). With
   no later segment the press advances as now, and a decision hanging off
   the item opens then. The active segment is in the machine's state,
   reset to none on every arrival at an item. Auto-forward, skip, an open
   choice and an auto-pick never step segments (their branches return
   first). Once a segment is active the item's media gate counts as met,
   so turning auto-forward on leaves on the text hold alone.
3. Renderer and sound follow the segment. When the active segment
   changes, the stage seeks once to its `startSeconds`, plays to its
   `endSeconds`, then loops `loopStartSeconds..endSeconds` until the next
   step, reporting no passes to the machine; `StageVideo.pass()` reports
   the segment's end and restart point, so the video's sound plays the
   segment and loops with it. Leaving the item, re-entering it or a
   reload plays the item's own range as now. A menu's pause and resume
   keep the segment.
4. check-game sees segment steps. The page shows the active segment
   (machine state, readable by `game.current()` in player/scripts/
   testing/kinetic.mjs), its summary line names it, and walk.mjs counts a
   change of segment as a change, so stepping six segments is not a stuck
   player and a segment item at the story's end does not end the walk
   early. The `--steps all` cap allows the extra presses.
5. Left and Right, and the note. On the item where Space steps segments,
   Right steps to the next segment as Space does but never advances (on
   the last segment it does nothing); Left steps to the previous segment:
   before any step, the segment before the one the video's time is in, or
   the last one starting before that time; after a step, the one before
   the active segment; nothing when there is none. Neither key does
   anything elsewhere. Each segment step (Space, Left, Right) shows "View
   n of m" for a moment, in the overlay's style, without blocking input.
   The help overlay lists the keys.
6. Docs: CREATE.md (marking segments, what Space and the arrows do, an
   example, how to check with check-game), docs/verify-player.md (the
   scenario rows), AGENTS.md if a command changes.
7. Phase-closer: full suites.

Tests and fixtures: scenarios use copies of fixtures/demo and
fixtures/audio-demo with `segments` added to an existing video item (the
audio demo's `video-sync` carries a video sound), written under the
scenario's own temporary root, so no fixture changes and no other
scenario's counts move. If a check needs a longer video, a synthetic one
is generated with the pinned or PATH ffmpeg in the same way; nothing from
any real game is used.

## Phase 50: Loops at a file's end in WebKit (2026-11-14, converting agent)

A converting agent reports that in WebKit (Safari, the macOS app,
check-game's default engine) a video whose pass ends at its file's end
loops back once and then stays on its last frame. Chrome loops the same
items without end. Ranges and segments that end inside the file loop in
both engines, and their `.mp4` files loop in both. They saw it on 16 of
16 sampled WebKit runs and on 42 of 116 cases of their own loop probe
under 6dfd1d6 (none restarted from 0, so Phase 49's play-after-seek
change holds); it predates segments (it is in e4232ff too). In their
game 339 items are `.mkv` ranges that run to the file's end, and 460 of
the 467 items with segments are `.mkv`, so the last view of most of
them stops looping in the macOS app. They will not change their manifest
for it; they upgrade once the player is fixed and rerun their checks.

Checked on their data, read-only (2026-11-14): the files are VP9 in a
Matroska container with no sound, 25 fps; one sampled file reports a
duration of 36.88 and its last frame starts at 36.84, one frame before
the end.

Today's code (player/src/render/visual.ts): `videoPlanFor` gives a plan
whose end is absent or at least `durationSeconds` the boundary `ended`,
and only `onVideoEnded` ends such a pass. A chain, background or segment
plan then plays on from its loop start (`playOnFrom`: the seek, and play
once it lands); a counted plan reports the pass first. The reading in
the report, not confirmed: WebKit fires `ended` once for these files, so
the second end of the file brings no event and nothing plays the video
on.

The same code has a second, related gap, which the agent already works
around: an end a float step below `durationSeconds` gets an rVFC
boundary that no presented frame ever reaches (the last frame starts
before it), and the `ended` that does fire is ignored, so the pass never
completes on either engine.

The orchestrator's choices, within the report:

- The fix is in the player. The converter keeps shipping `.mkv` as it
  is; the agent's folder needs only the new player.
- A loop-back at the file's end must not depend on WebKit firing `ended`
  at every end. The design follows item 1's findings; if they leave a
  real choice (for example between a watch on the last frame and a stall
  watch), it goes to the user before item 2.

Item 1 found that WebKit sends `pause` and `ended` only at a Matroska or
WebM file's first end; at every later end it sends only its periodic
`timeupdate` (currentTime at the duration, `ended` true, `paused` false)
and the video holds on its last frame. Native `loop` sticks the same
way. The user's decision (2026-11-14): the file's end is whichever comes
first of three signals: the frame callback presenting the last frame
plus one frame interval (seamless in the usual case), a `timeupdate` at
the duration (the catch-all, up to about 0.25 s late in WebKit), and the
native `ended`. Each end is handled once, the element is paused before
the end logic runs, and an end seen while seeking or below the duration
is ignored.
- The second gap is fixed in the same item: reaching the file's end
  completes the pass of any range whose end lies at or past the last
  frame.

1. Reproduce and diagnose, in WebKit and Chrome. With synthetic clips made
   by PATH ffmpeg under `.tmp/` (about 6 s, 25 fps, VP9 in `.mkv` and in
   `.webm`, H.264 in `.mp4`, no sound, each with its last frame one frame
   before its duration as the agent's files have), play an item whose
   range runs to the file's end with a loop start mid-file, as a chain,
   as a counted `loopCount` 3 and as a last segment, through
   `openGame`. Over 3 wraps, sample `currentTime` every 50 ms and log,
   at each end of the file, which of `ended`, `pause`, `timeupdate`,
   `seeking`, `seeked`, `waiting` and `stalled` fired, with `paused`,
   `ended`, `currentTime`, `duration` and `readyState` once playback
   stops. Also an end a float step below `durationSeconds`. The findings
   (which containers fail, which signals arrive at the second end, the
   cause) go in the evidence note; no player change.
2. Fix. A pass that ends at the file's end loops back at every end in
   both engines, for chain, background, counted and segment plans; a
   counted plan still reports exactly one pass per end and never one
   twice for the same end; a range whose end lies at or past the last
   frame completes its pass at the file's end. Unit tests for the plan
   and the boundary logic, and a new scenario file (WebKit and Chrome)
   on a copy of a demo folder with the synthetic clips, red first on
   WebKit, checking 3 wraps to the loop start for each case.
3. A counted video opened by `#start=`. Item 1 found that a video item
   with `loopCount` 3 opened at page load by `#start=<id>` (and so by
   `openGame({startAt})` and check-game's `--start-at`) plays one pass
   and holds, on both engines and every container; reached by Space, or
   after a reload, it plays its 3 passes. Diagnose, then fix so that
   every way of arriving plays the item's passes. Tests: a unit test or a
   scenario part, red first, on both engines. (Added 2026-11-14, the
   user's decision.)
4. A segment stepped to from a held end. Item 3 found that Left on a
   counted item whose last pass is done (the element paused and ended at
   the file's end) steps to a segment and plays the ended element at
   once, without waiting for the seek; WebKit played on from 0 instead of
   the segment's start in 3 of 28 runs. Play a stepped segment on an
   ended element only once its seek lands, as a loop-back does. Tests:
   red first where it can be shown (a unit test of the order; a scenario
   part on both engines). (Added 2026-11-15, the user's decision.)
5. A menu over a video held at its file's end. Item 4 found, and the
   orchestrator saw again on WebKit, that opening and closing the Esc
   screen over a counted video held at its file's end (paused, `ended`)
   plays the whole file from 0, footage before the item's start
   included, and on `.mkv` then sticks "playing" on the last frame;
   Chrome stays held. `setPaused(false)` seeks to the current time and
   plays the ended element at once. A video held at its end stays held
   when a menu closes (and the branch map, a hidden page, anything that
   holds and resumes); one paused mid-pass resumes as now. Tests: red
   first, a unit test and a scenario part on both engines, no extra pass
   reported. (Added 2026-11-15: bugs found during the phase are fixed in
   it, the user's direction.)
6. Docs. docs/content-format.md "Video playback ranges" (it still says
   `ended` comes from a `timeupdate` clamp) and "Video segments" where
   they describe the file's end; docs/verify-player.md (the scenario
   rows); CREATE.md if what an author must do changes (the note that a
   last view must end exactly at the file's end).
7. Phase-closer: full suites.

Tests and fixtures: synthetic clips only, generated by PATH ffmpeg into
the scenario's own temporary root, as videofit.scenario.mjs does;
fixtures and other scenarios' counts do not move. Nothing from any real
game is used.

## Phase 51: Release basics (2026-11-15, user)

What a public release needs before anyone else builds games with Kinetic
(docs/future.md's "Release basics" entry, now removed from there). Today
the repo has no license file (only `converter/vendor/unrpyc/LICENSE`,
MIT); tags v1.0.0 to v1.7.0 sit on `main` at phase-closing commits while
`player/package.json` says 0.0.0 and `converter/pyproject.toml` 0.1.0,
and nothing an author or reader sees names the Kinetic release; the
manifest has no field for the game's own version; its top level rejects
`"$schema"` (`additionalProperties: false`), so editors cannot check a
hand-written `manifest.json`; and CREATE.md, "Upgrading to a newer
Kinetic", upgrades a folder with a manual `cp` that must warn against
copying `player/dist/manifest.js`.

The user's decisions (2026-11-14 and 2026-11-15):

- License: MIT for everything (player, apps, converter, tools),
  `Copyright (c) 2026 Sendu Bala`. The notice travels inside what an
  author ships, so authors do nothing. The Windows program also carries
  Go's BSD-3-Clause notice, for the Go runtime linked into it.
- Kinetic's version: every closed phase is a release. Patch for fixes
  only, minor for a feature or a new optional manifest field, major for a
  change that stops existing game folders or saves working, which is
  also the only time `schemaVersion` moves. Between releases the version
  reads as the next one with `-dev` (such as `1.9.0-dev`). This phase
  closes as v1.8.0. A CHANGELOG lists what each release changed,
  including short entries for v1.0.0 to v1.7.0.
- Where the versions show: the game's version after the `title` heading
  on the Esc screen, smaller and dimmer (with no title, the version
  alone where the heading would be); `Kinetic x.y.z` small and dim in a
  corner of the Esc screen, outside the key grid. Also `--version` on
  the tools and the folder's player version in check-game's output.
- The game's version is the optional manifest field `version`, plain
  text, 1 to 40 characters with a non-space character, set as text;
  kinetic-extract fills it from the Ren'Py `config.version` string
  literal, as it fills `title` from `config.name`.
- `$schema`: each content folder kinetic-extract writes gets a copy of
  the schema, `manifest.schema.json`, and its manifest says
  `"$schema": "./manifest.schema.json"`. The upgrade command refreshes
  the copy and the assembler leaves it out of the folder readers get.

The orchestrator's choices, within those decisions:

- One source of truth for Kinetic's version: a `VERSION` file at the
  repo root (`1.8.0-dev` during this phase). `player/package.json` and
  `converter/pyproject.toml` agree with it (pyproject in its PEP 440
  spelling, `1.8.0.dev0`), checked by a test. Each phase's planning
  commit sets the next `-dev`; its closing commit sets the release
  number, dates the CHANGELOG entry, tags it and fast-forwards `main`.
- The upgrade command is `tools/upgrade_folder.py <folder>`, beside
  `tools/assemble_folder.py`; one `kinetic` command is a separate
  future.md entry. kinetic-extract's override for the game's version is
  `--game-version` (`--version` prints the tool's own).
- The Mac app's `CFBundleShortVersionString` and the exe's numeric
  version stay as they are (both must be numeric; a game's version is
  free text).

1. License. `LICENSE` at the repo root (MIT, the notice above);
   `"license": "MIT"` in `player/package.json` and the pyproject's
   license field. The build puts the full MIT notice in a comment at the
   top of `dist/app.js` and `dist/index.html`, so every folder carries
   it. The Mac app's Info.plist gets `NSHumanReadableCopyright` and the
   bundle carries the license text in `Contents/Resources`; the exe's
   version resource gets `LegalCopyright` and the exe carries Kinetic's
   MIT text and Go's BSD-3-Clause text in its resources. README.md says
   the license and that an author owes nothing beyond leaving the files
   as built. Tests: the built bundle carries the notice; build_apps
   tests read the plist key, the bundle's file and the exe's resources.
2. Kinetic's version stamped. `VERSION` as above and the agreement test.
   The build stamps the version into `app.js` (a header line naming it,
   and a value the player reads) and `index.html`'s comment. `--version`
   on `kinetic-extract`, `kinetic-media`, `tools/validate_content.py`,
   `tools/assemble_folder.py`, `tools/build_apps.py`,
   `tools/setup_media_tools.py` and `check-game.mjs` prints `Kinetic
   x.y.z`. check-game's first line names the folder's player version
   (`webkit: <folder> (Kinetic 1.8.0)`), `unknown` for an older player,
   and `openGame`'s handle exposes it. The Mac app's Info.plist and the
   exe's version resource record the Kinetic version that built them.
   AGENTS.md's workflow gains the version rules above. Tests: the
   stamp, each `--version`, check-game on a folder with this player and
   on one whose `app.js` has no stamp.
3. The game's version in the format. Schema, docs/content-format.md
   ("Manifest", with `title`), validator, `types.ts`; kinetic-extract
   reads `config.version` (a string literal, `_()` unwrapped, as for
   `config.name`; anything else gives no field) and takes
   `--game-version TEXT`. Tests: validator cases (absent, valid, empty,
   blank, 41 characters, not a string), extractor cases (literal,
   `_()`, a non-literal, absent, the flag), the demo still validates.
4. The versions on the Esc screen. The game's version after the title
   heading, smaller and dimmer, set as text, never cut off by a long
   title; with no title the version alone; with neither, no heading. A
   small dim `Kinetic x.y.z` in a corner of the Esc screen outside the
   key grid, clear of the Volumes pop-out, the window controls and the
   pill at every supported size. The page title stays the game's name.
   Tests: help.test.ts; a scenario part on Chrome and WebKit (both texts,
   no overlap with the grid or other controls, a long title).
5. `$schema` and the schema policy. The schema accepts a top-level
   `$schema` string, which the validator and player ignore.
   kinetic-extract writes `manifest.schema.json` (a byte copy of
   docs/content-schema.json) beside `manifest.json` and sets
   `"$schema": "./manifest.schema.json"`; `tools/assemble_folder.py`
   leaves the copy out of the folder it assembles. docs/content-format.md
   gains `$schema` under "Manifest" and a "Schema version" policy: new
   optional fields never change `schemaVersion`; it changes only when a
   folder valid before stops being valid or plays differently, with a
   major Kinetic release, and an older player ignores fields it does not
   know. Tests: validator cases; the extractor writes the copy and the
   key; the assembler leaves the copy out; the copy validates as JSON
   Schema and matches docs/content-schema.json byte for byte.
6. The upgrade command. `tools/upgrade_folder.py <folder>` refuses a
   folder with no `manifest.json`, and a `player/dist/` that is missing
   or whose stamped version is not `VERSION` (it says to run `npm run
   build`). It copies `index.html` and `app.js` from `player/dist/`
   (never `manifest.js` or `app.js.map`), replaces `manifest.schema.json`
   with the current schema when the folder has one, runs the validator,
   and prints `Kinetic <old> -> <new>` (`unknown` for an older
   `app.js`). An app in the folder keeps working. Exit 0 when the
   validator passes, 1 on its problems or a refusal, 2 on bad arguments,
   as `assemble_folder.py` does. Tests: an old folder upgraded, the
   refusals, `manifest.js` untouched, the schema copy refreshed or left
   absent, the exit codes.
7. CHANGELOG. `CHANGELOG.md` at the repo root, newest first: a
   `1.8.0-dev` section listing this phase as items land, and one short
   entry per tag from v1.7.0 back to v1.0.0 with its date, written from
   the tags' commits and the phase sections here, in terms an author or
   reader cares about (no internal item numbers, no game named).
8. Docs. CREATE.md: upgrading with the command (replacing the manual
   `cp`), the game's `version`, `$schema` and the schema copy (with
   hand-authors told to copy docs/content-schema.json), what the license
   asks of an author (nothing beyond shipping the files as built);
   README.md: license and versions; AGENTS.md: the new command and
   `--version`; docs/packaging.md if what a folder holds changes;
   docs/verify-player.md: new scenario rows. Every example run.
8b. Scrub real games from the repo's text (added 2026-11-15, the user's
   decision). Text from before the 2026-11-09 rule names corpus games:
   docs/extracting.md's corpus survey (names and paths under the corpus
   root, including its category folders), the docs/content-format.md
   Manifest example, converter and validator tests, code comments, and
   docs/plan.md and docs/progress.md notes. Every real game name, path
   under the corpus root and piece of game content becomes synthetic or
   generic ("a converted corpus game"); the corpus root itself stays
   named in AGENTS.md as the read-only reference data. Tests keep their
   logic with synthetic names; vendored files stay byte-identical. Git
   history and commit messages still hold the names: the user chose to
   rewrite history before the repo goes public, as its own step with its
   own confirmation, not part of this item.
9. Phase-closer: full suites; then `VERSION` 1.8.0, the CHANGELOG entry
   dated, the tag v1.8.0 and `main` fast-forwarded.

Tests and fixtures: synthetic cases only; nothing from any real game is
used. The demo and audio demo builders gain no `version` unless a
scenario needs one on a copy.

## Phase 52: Spoken lines (2026-11-15, user)

Every line of a game can be spoken in its speaker's own voice, generated
on the reader's machine. docs/voice-reading.md holds the research behind
it: the engines compared, the measurements and the rejected paths
(browser speech, Zonos, Fish recordings). docs/future.md's "Read-aloud"
entry is removed from there.

The user's decisions (2026-11-15):

- The engine is Chatterbox multilingual v3 (MIT, Resemble AI), cloning
  each character from a reference clip. The user rated its line readings
  best of the models that run on a Mac, ahead of Ming-3.0 and Qwen3-TTS.
- It runs live on the reader's machine. Kinetic does not distribute the
  model: the reader opts in, and the app downloads it.
- Every speed-up found in the research is used: each character's voice
  conditioning is computed once, and the model's text-to-token
  transformer is quantized to 8 bits when it loads. 4-bit only if it
  ever gives a smaller download. (The research's 0.35x real time on an
  M2 left out the decoder; item 2 measured 1.03-1.11x, and item 2b looks
  for the speed back.)
- Voices are designed at author time with Qwen3-TTS 1.7B VoiceDesign:
  the author describes a character, picks one of several takes, and that
  take ships as the character's reference. It was the only usable voice
  designer tried.
- No Fish recording support, and lines are spoken as written, with no
  direction markup.
- The Mac app first, demonstrable with its in-app download; then as far
  as possible with the Windows app, checked over SSH on the user's
  Windows PC.
- The user is away for this phase: the orchestrator decides open points
  and lists them in docs/voice-reading.md, "Questions for the user".

The orchestrator's choices, within those decisions:

- **One voice install per machine.** Mac:
  `~/Library/Application Support/Kinetic/Voice/`; Windows:
  `%LOCALAPPDATA%\Kinetic\Voice\`. Every Kinetic game app on the machine
  shares it. It holds a private Python, the pinned packages, the model
  files, the helper and a cache of generated lines.
- **The helper.** A Python program of ours, `kinetic_voice`, embedded in
  each app's binary and written into the voice folder, so app bundles keep
  their layout. The app starts it with the private Python and talks to it
  by JSON lines on stdin and stdout: no network port, so no firewall
  prompt. It installs the packages and model files, then voices lines.
- **The download.** The app fetches the Python build (python-build-standalone,
  sha256-pinned) and unpacks it with the system `tar`; the helper then
  installs pinned wheels by hash (`pip --require-hashes --only-binary
  :all: --no-deps`) and fetches the model files at pinned revisions with
  sha256 checks and resume. On the Mac that is about 3.3 GB: the model
  2.71 GB, its speech tokenizer 0.49 GB, the runtime about 0.15 GB. The
  sources are python-build-standalone's GitHub releases, PyPI and Hugging
  Face; the user never touches a terminal.
- **The bridge.** `window.kineticHost` gains `voice: true` on hosts that
  offer it. The page sends `{type: "voice", op, ...}` through `send`; the
  host answers by calling `window.__kineticVoice(event)`. Generated audio
  comes back as base64 WAV (24 kHz, 16-bit mono).
- **The manifest.** An optional top-level `voices` object maps a speaker
  name, exactly as items give it, to `{file, text?, description?}`: the
  reference clip (an audio file with its `.js` script, as tracks have),
  its transcript and the description it was designed from. An optional
  `narrator` voice of the same shape speaks lines with no speaker.
- **What is spoken.** With spoken lines on, every item with text whose
  speaker has a voice (or, with no speaker, when there is a narrator) and
  no recorded `audio.voice`. Thoughts are spoken in the speaker's voice.
  Speaker names are not spoken. A recorded voice line always wins.
- **How it plays.** A generated line behaves like a recorded voice line:
  the Voice bus and volume, held under the Esc screen, the branch map
  and a hidden page, stopped when the reader leaves the item, and
  auto-forward waits for its end. The player asks for the current line
  and the next three along the reading path, newest first, and drops
  requests the reader has moved past. A line not ready on arrival plays
  when it is ready, if the reader is still there; auto-forward waits for
  it up to 20 s. Generated lines are cached on disk by the helper, keyed
  by model, settings, voice and text, so a reread is instant.
- **The setting.** A "Spoken lines" row on the Esc screen, shown only in
  an app that offers voice and in a game with `voices` or `narrator`. It
  offers the download with its size, shows progress with Cancel, then an
  on/off switch (on after the download) and "Remove" to free the space.
  Errors show with Retry. On an Intel Mac the row says it needs Apple
  silicon.
- **Casting.** `tools/cast_voices.py` reads a JSON file of speaker
  descriptions, makes four candidate takes each with Qwen3-TTS
  VoiceDesign (Apple silicon; its packages pinned in
  `requirements-voice.txt`, outside the converter's install), and writes
  them with a listening page (`design`). `pick NAME=N` copies the chosen
  take into the game as FLAC with its `.js` script and records it in
  `voices`; `record NAME=FILE` uses the author's own clip instead.
- **Windows.** The same helper with a PyTorch backend running Resemble's
  own `chatterbox-tts` package, on CUDA when an NVIDIA GPU is present and
  otherwise on the CPU (measured; if too slow, the row says so).

1. The manifest's `voices` and `narrator`. Schema,
   docs/content-format.md (a "Voices" section), validator (paths and
   scripts as for tracks; a voice no item's speaker uses is a warning),
   `types.ts`, parseManifest's path checks. Tests: validator cases
   (valid, missing file, missing script, bad shape, unused voice), the
   demo still validates, manifest.test.ts.
2. The helper, Mac backend. `apps/voice/kinetic_voice/` (stdlib only
   outside the engine): the JSON-lines protocol (`install`, `status`,
   `voice`, `speak`, `cancel`, `quit`, and progress events), the install
   steps for a lock file (`apps/voice/lock-macos-arm64.json`: wheels with
   hashes, model files with revisions and sha256), the Chatterbox MLX
   engine with the speed-ups, a priority queue (the reader's current line
   first), and the disk cache. A fake engine for tests. Tests: protocol,
   queue order and cancel, cache keys, install against a local file
   server with fake wheels and model files (hash failure, resume, cancel),
   and one real check on this Mac: install into `.tmp`, then voice the
   test line and time it.
2b. Faster lines (added 2026-11-15 from item 2's real check). Lines take
   1.03-1.11x real time on an M2, too slow to keep ahead of a reader.
   Find a setting or change that brings it well under real time without
   an audible loss, judged by Whisper, the speaker match and the pause
   and stress measures of docs/voice-reading.md, with samples kept for the
   user. Candidates: fewer flow steps, Chatterbox Turbo's one-step decoder
   behind the multilingual model's tokens, compiling the decoder. Also
   stream a line in chunks, so it can start before it is finished.
3. The Mac host. A shared `apps/macos/VoiceEngine.swift` compiled into
   the app and the WebKit driver: the voice folder, downloading and
   unpacking Python (progress, cancel, resume, disk-space check), writing
   the embedded helper, running and restarting it, and relaying the
   bridge. `KineticHostBridge` advertises `voice` and accepts the voice
   messages from the main frame only. Test overrides by environment
   (voice folder, download base URL, helper command) for the driver.
   Tests: build_apps (the helper embedded, the bundle listing unchanged),
   driver-based scenario parts with a fake helper and a local server.
4. The player. The Esc screen row and its states; the voice client
   (status, install, cancel, remove, voice registration with the
   reference clips' bytes, speak, cancel); the lines chosen as above;
   prefetch and dropping; playback through the Voice bus with the hold
   rules above; a game with `voices` but no audio still mounts sound and
   shows the Voice volume. Tests: unit tests for line choice, prefetch,
   the hold and the row; a `spoken` scenario file on Chrome and WebKit
   with a fake host.
4b. Streamed lines in the player (added 2026-11-15 from item 2b). When
   the reader reaches a line that is not ready, the player asks for it with
   `stream: true` and plays its chunks back to back without a gap as they
   arrive, so the line starts after about 1.7 s instead of after the whole
   line; prefetched lines stay unstreamed (streaming costs about 1.6x the
   work). The hold counts from the first chunk and ends at the line's end.
   Tests: unit tests for chunk scheduling and the hold; spoken scenario
   parts with the stand-in host streaming.
5. Casting. `tools/cast_voices.py`, `requirements-voice.txt`. Tests: the
   picking and manifest writing with a fake generator; one real casting
   run on this Mac.
6. The voice demo. `fixtures/build_voice_demo.py` builds the gitignored
   `fixtures/voice-demo`: two characters and a narrator over the demo's
   pictures, with reference clips cast by item 5 and committed under
   `fixtures/voices/`. Built as a Mac app and checked end to end on this
   Mac: the download into a `.tmp` voice folder, then a walk with the
   lines generated and their timing recorded. The user's own voice folder
   is left empty, so the demo starts with the download.
7. Docs. docs/voice-reading.md (the Mac models round, the decisions,
   "Questions for the user"), CREATE.md ("Giving characters voices"),
   README, apps/README.md (the voice bridge), docs/packaging.md,
   docs/stack.md (the voice install is the one opt-in download), AGENTS.md
   (the commands), CHANGELOG.
8. The helper, Windows backend. The PyTorch engine and
   `apps/voice/lock-windows-x64.json` (CPU and CUDA variants), with the
   install and a timed line checked over SSH on the user's PC, on CUDA and
   forced to the CPU.
9. The Windows host. Embedded helper, the voice folder, downloading and
   unpacking Python, running the helper, the bridge over
   `chrome.webview.postMessage` and `ExecuteScript`. Tests: `go test` on
   the neutral parts, `GOOS=windows go vet`, the cross-build; over SSH, a
   headless run of the download and helper. The windowed app needs the
   user.
The user's decisions after trying the Mac demo (2026-11-16):

- The sound controls follow what the game has. The Volumes sheet shows
  Music only for a game with music or ambience, Effects only with
  effects, and Voice only with voice lines, recorded or spoken. A game
  with none of them shows no Volumes... button. The Spoken lines row
  goes: the voice model's download button takes the Voice slider's place
  in the sheet, with its explanation in a ? help shown on hover. Once
  the model is installed the slider shows, with a small "remove voice
  model" button beside the Voice label. There is no on/off switch for
  spoken lines; the Voice volume controls them.
- A drag on a slider that ends outside the sheet must not close it.
- Every line of the demo is spoken, the radio's too.
- Windows offers spoken lines only with an NVIDIA card. Without one, the
  download button shows greyed out and its ? says why.
- Recorded lines. A large game's voices come to about 0.8 GB as Opus at
  16 kb/s in base64 scripts (docs/voice-reading.md, "A large game"),
  against a model download of 3.3 GB on the Mac and 6.8 GB on Windows.
  So authors get a tool that records every line with the same engine,
  compresses it and writes it into the manifest as recorded voice lines.
  A game whose lines are all recorded offers no download: the Voice
  slider shows at once, in a browser tab too.

The orchestrator's choices, within those decisions:

- A Voice volume of 0 asks the engine for no lines. The `spokenLines`
  setting goes; a saved or imported one is ignored.
- The voice model is offered only when some line needs it: an item that
  would be spoken and has no recorded `audio.voice`.
- Windows drops the lock's CPU variant. With no NVIDIA GPU, or a driver
  older than the lock's minimum, the host reports voice as unsupported
  with the reason, the state an Intel Mac already shows.
- The recorder drives the same `kinetic_voice` helper as the apps, from
  the machine's voice install, so a recorded line sounds as the live one
  would. Each line's seed comes from its voice and text, so a rerun
  records the same audio. A rerun records only new or changed lines and
  deletes the files it made that no item uses any more.

10. Sound controls by content (added 2026-11-16, user). The Volumes
    sheet's rows by what the game has, the Voice row's download, help,
    progress, error and remove states in place of the Spoken lines row,
    no `spokenLines`, a Voice volume of 0 asking for no lines, and no
    Sound row or `v` for a game with no sound the reader can hear.
    Tests: unit tests for the rows, the Voice row's states and the help;
    `spoken`, `screens`, `audio` and `machost` scenario parts on Chrome
    and WebKit.
11. A drag that ends outside the Volumes sheet leaves it open (added
    2026-11-16, user): the scrim closes the sheet only for a press that
    starts and ends on it, and the confirmation box the same way. Tests:
    a unit test and a scenario part for the drag.
12. Windows voice needs an NVIDIA card (added 2026-11-16, user). The CPU
    variant removed from the lock and the engine; the host's unsupported
    state with its reason; the greyed button and its ? text in the
    player. Tests: go test, vet, the cross-build, apps/voice tests, a
    player unit test; over SSH, the host's check on the user's PC.
13. Recorded lines (added 2026-11-16, user). `tools/record_lines.py`
    records every line that would be spoken, with the helper and the
    machine's voice install (installed first if missing, as the apps do),
    as mono Opus in WebM at 16 kb/s (`--bitrate`) with the pinned ffmpeg,
    each file with its `.js` script, a track per line in `audio.tracks`
    and the item's `audio.voice`. It resumes after an interruption and
    reports progress with time left. Docs: CREATE.md, content-format.md,
    voice-reading.md. Tests: a fake engine for the manifest writing,
    reruns and cleanup; one real recording of the voice demo on this Mac,
    played in Chrome and WebKit with no voice install.
14. The radio's voice (added 2026-11-16, user). A fourth reference clip,
    designed with `tools/cast_voices.py` and committed under
    `fixtures/voices/`, gives the demo's radio a voice. Tests:
    tools/test_build_voice_demo.py.
15. App wording (added 2026-11-16, user). In a game app the player's
    words never mention a browser: the Progress help says "Saved as you
    read. Export and Import carry it to another device." and every other
    text that names a browser (the import box, storage errors, the window
    controls) has an app wording, chosen by whether a host is present.
    The browser tab keeps today's words. Tests: unit tests for each text
    in both forms; a `screens` part with the emulated app host.
16. Phase-closer: full suites; VERSION 1.9.0, the CHANGELOG dated, tag,
    `main` fast-forwarded. The user approved the Mac and Windows apps on
    2026-11-16.

Tests and fixtures: synthetic text only, and the reference clips are
designed voices, not anyone's recording.

## Phase 53: Docs after 1.9.0 (2026-11-16, user)

Three docs released in 1.9.0 still describe spoken lines on Windows as
still to come, though the Windows program has them (Phase 52, item 12):
CREATE.md, "Giving characters voices" ("The Windows program is getting
the same sheet ... Until it ships"), README.md's feature list ("in the
Mac app (the Windows program is next)") and docs/packaging.md ("needs the
Mac app today (the Windows program is next)"). The user asked for them to
be fixed. Docs only, so this phase closes as the patch release 1.9.1.

1. Windows spoken lines in the docs. Those three places, and any other
   user-facing doc found saying the same (a grep of the Markdown for
   wording that puts Windows spoken lines in the future, or that says
   only the reader's Mac generates lines), describe the shipped
   behaviour: the Mac app (Apple silicon, macOS 14 or later, about
   3.3 GB) and the Windows program (an NVIDIA card with driver 570.65 or
   later, about 6.8 GB) both offer the download; elsewhere the button is
   greyed out and its ? says why; a browser plays unrecorded voices
   silently. docs/progress.md and the plan's history stay as written.
   Tests: none (Markdown only); the full pytest at the close covers the
   tests that read the docs.
2. Phase-closer: full suites; VERSION 1.9.1, the CHANGELOG dated, tag,
   `main` fast-forwarded.

## Phase 54: Item trace for tests (2026-11-17, converting agent)

The converting agent's check for decisions with `continue` routes must
show that a first-time reader goes from a pick straight to the
decision's `continueAt` with no stray choice screen, and that Play all
runs each route once. It cannot ask the player which items were shown,
so it reads the player's IndexedDB state writes. Those writes coalesce
during a skip burst (the writer keeps one write in flight and one
pending snapshot, `player/src/main.ts`), so runs of items never reach
the log: on a 57,232-item draft with 50 such decisions the check failed
5 times, reaching the next choice screen before `continueAt` showed in
the log, or jumping over about 120 items. The stage's `data-item`
(Phase 46, item 2) names the item on screen, but a poll misses the
items of a burst too. They asked for an opt-in, test-only trace of
every screen shown, in order, absent from normal play, and for
check-game to expose it; they are fixing their tool meanwhile and
would switch to the trace, keeping page reading for older players.

Settled from the request (the record's names were left to us): the
trace is both an array and an event; it records arrivals, so a skip
burst's items all appear; a video's segment steps are not arrivals and
get no record (an arrival never lands on a segment); the array is
capped with a counter, never silently; nothing is heard or timed
differently. A feature, so this phase closes as 1.10.0.

1. Player trace. `window.KINETIC_TEST_TRACE = true`, set before the
   player starts, turns it on; the player reads the flag once at start
   and, when it is unset, subscribes nothing and defines no globals.
   When on, every record is appended to `window.__kineticTrace` (an
   array the player creates) and dispatched on `document` as a
   `kinetic:item` `CustomEvent` whose `detail` is the same record
   (frozen, plain JSON). Records, in the order they happen:
   - `kind: "item"`, one per machine arrival (`Machine.arrival()`, its
     number changing; a re-emit gives none): `itemId`, `type` (the
     item's type: image, animation, video, text), `arrival` (read,
     skip, walk or jump), `routeStack` (the open routes, outermost
     first, as `{ decision, route }` ids, as the saved state has them),
     `playAll` and `skipping`.
   - `kind: "choice"`, each time a choice screen opens (a new
     arrival's, a choice appearing on the same item, or a different
     decision's): `itemId` (the item it is drawn over), `decisionId`,
     `routes` (the route ids offered, in order), `returnRow` (the
     "Return to main route" row is offered), `autoPick` (Play all is
     answering it), `walked` (the wheel walked onto it), with
     `routeStack`, `playAll` and `skipping`.
   - `kind: "end"`, each time the end card shows: `itemId`, with
     `routeStack`, `playAll` and `skipping`.
   Every record carries `n`, counting from 0 per page load over all
   records, so a gap shows. Within one state change an item record
   comes before its choice or end record. The array holds at most
   200,000 records; past that a record is not appended but still gets
   its `n` and its event, and `window.__kineticTraceDropped` counts it.
   A reader may empty the array (`length = 0`) to make room; the player
   keeps appending to the same array. A render-layer module subscribed
   from main.ts; the game apps never set the flag. Tests (vitest): every
   item of a Tab skip burst appears once, in order, matching the
   machine's own path; a Play all walk over decisions with continuing
   routes (each route once, then `continueAt`, no other choice record);
   choice records with the return row, play-all countdown and a walked
   screen; an end record; the cap and its counter; draining; no flag, no
   globals and no listener. Scenario file `trace`, Chrome and WebKit: a
   skip burst over `fixtures/demo` traced with no gap and the event's
   detail equal to the array's record; no flag, no `__kineticTrace`.
2. The trace in the testing tools. `openGame(folder, { trace: true })`
   sets the flag before the player starts; the handle's `trace()`
   resolves with `{ records, dropped }`, the records since the last call
   (it empties the page's array), and rejects naming the folder's
   player when that player keeps no trace (an older player).
   `check-game --trace FILE` traces its walk and writes every record to
   FILE as one JSON line, and the summary says how many records and how
   many dropped; an older player fails the run with exit 1 and that
   reason. Tests: the argument parsing (walk.test.mjs), the handle on a
   built demo with a pick and a Play all run (kinetic.test.mjs), and the
   written file's records numbered from 0 with no gap.
3. Docs: CREATE.md, "Testing your game" (the trace: flag, records,
   event, cap and draining, detecting an older player with
   `folderKineticVersion`, the stage's `data-item` for the one item on
   screen; `trace()`; check-game `--trace`), AGENTS.md's check-game
   line, docs/verify-player.md (the `trace` scenario), the CHANGELOG.
4. Phase-closer: full suites; VERSION 1.10.0, the CHANGELOG dated, tag,
   `main` fast-forwarded.

## Phase 55: Reliable WebKit map checks, plain commit messages (2026-11-17, user)

Phase 54's closing WebKit run failed 10 checks in the scenario files
`bookmarkmap` and `screens`, though its first full run passed them. Run
alone at load average 5-8 (nothing else busy), the two files failed 1
run in 3 at 1.10.0 and 2 runs in 4 at 1.9.1, so the fault predates the
trace; Chrome passes them. The checks seen failing: "through 8 drags
the cards and the lines move together" (a drag of dx -160, dy 20
scrolled 0 where 20 was wanted), "a drag that starts on a card scrolls
the map...", "clicking a card opens its bookmark", "x at Full size
deletes the bookmark...", then a cascade of later steps in the same
part (m reopens the map, the x on a card, reload resumes, the bookmark
at its new place, `u` from chain-still-3), and once the screens check
"skip from the bookmark stops on inserted-1". The user asked for a fix.

The user also asked that commit messages describe the change rather
than record test runs: recent subjects run to 200 characters of test
counts and verify results. No repo file says how to write them, so
agents copied the history.

A fix with no new feature, so this phase closes as the patch 1.10.1.

1. Commit messages. AGENTS.md's Git section says how the orchestrator
   writes them: a short subject, `area: what changed` (player, tools,
   converter, windows, macos, docs...), with the phase and item when
   there is one; a body only when the reason or the shape of the
   change needs saying; no test counts, verify results, load averages
   or other run evidence, which belong in the item's evidence note in
   docs/progress.md; planning and closing commits likewise (the closer
   says the release, e.g. `release 1.10.1`). History is not rewritten.
   Tests: none (Markdown); the closer's full pytest covers tests that
   read AGENTS.md.
2. WebKit map checks. Find why `bookmarkmap` and `screens` fail on and
   off on WebKit, and fix the cause: a race in the scenarios' drag or
   click helpers, in the WebKit driver, or a real player fault on
   WebKit (Safari readers and the Mac app), which is fixed in the
   player, not hidden in the test. A step that fails stops its part
   cleanly rather than cascading where the harness allows. The report
   names the cause with the evidence for it. Tests: a unit test for a
   player or driver fault where one can show it; `npm run verify --
   --webkit bookmarkmap screens` passes 10 runs in a row at normal load,
   and the same files on Chrome.
3. Phase-closer: full suites; VERSION 1.10.1, the CHANGELOG dated, tag,
   `main` fast-forwarded.

## Phase 56: Translations (2026-11-16, user)

Planned as Phase 54 on the `language` branch and renumbered 56 when
that branch was rebased onto develop's Phases 54 and 55 (2026-11-17);
its commits before the rebase say "Phase 54".

A game can be read in more than one language, in one folder, and the
player's own words come in many languages. The user scheduled
docs/future.md's "Translations" entry, which is removed from there. A
converting agent's feasibility note (2026-11-16) fed the design: its
game's original ships seven filled translations for about 96% of its
lines, and its measurements (German 1.17 of the English characters,
Chinese 0.37, the longest German line three wrapped lines in the band)
show that one translated text per item fits the existing band. The
design serves freshly written games too, whose translations come later
from contributors.

The user's decisions (2026-11-16):

- **The Language control** sits in the Esc screen's title bar, at the
  right of "Esc or Space closes", and shows only when the game has more
  than one language, so its presence changes no height. Below 700px wide
  it stays on the title's line. It shows a globe and the current
  language in its own name; a click opens a list over the screen (each
  language in its own name), so opening it moves nothing either. Escape
  closes the list first, then the screen.
- **A missing line** is a build-time warning (the validator reports each
  one and the coverage per language); in play it shows the original.
- **The starting language** is the reader's system language when the
  game has it (a loose match: `de-AT` takes `de`), otherwise the game's
  own. The reader's choice on the Esc screen then wins, saved in the
  settings per `storyId`.
- **The player's own words** (Esc screen, help, choice hints, end card,
  branch map, Volumes sheet, pills, confirmation boxes) come from a
  catalogue in as many languages as can be written well and drawn by
  system fonts.
- **Fonts:** system fonts only. A language file can neither name nor
  ship a font. The player chooses a readable system stack per writing
  system and marks text with its language, so Chinese, Japanese and
  Korean draw their own forms of shared characters. Shipped fonts are
  not wanted at all (docs/future.md, "Not wanted").
- **Spoken lines:** the shown language is spoken. A language file may
  carry its own recorded lines; without one for an item, the apps
  generate the line live in the shown language, and a browser, or a
  language the engine lacks, stays silent. A language file may instead
  say "keep the original voice lines": then the base recordings play
  under its text, like subtitles. The converter sets that for Ren'Py
  games with acted `voice` lines, as Ren'Py itself does.
- **Pictures** are the same in every language. Per-language pictures
  wait in docs/future.md as a maybe.
- **The translator format** is PO (gettext) only, for games and for the
  player's own catalogue.
- **Right to left** is supported fully, within limits: game text,
  choices, prompts, route labels, the Esc screen, help, end card and
  pills mirror for Arabic, Persian, Hebrew and Urdu; the branch map's
  layout does not (its labels still run right to left), and arrow keys
  keep their physical meaning.
- **The Language control lists the story's languages only**
  (2026-11-17, after checking the demo): the player's other control
  languages come from the system, app or browser language, not from
  the control, so it stays absent in one-language games.
- **kinetic-extract** reads Ren'Py's `translate` blocks: an official
  Ren'Py feature, with a real example in the corpus (a game with `tl/`
  folders in 14 languages, about 4,400 dialogue blocks each, plus
  `translate xx strings` blocks for menu choices). It ignores Ren'Py's
  `translate xx style` fonts and per-language file replacements, which
  the decisions above leave out.

The orchestrator's choices, within those decisions:

- **One folder.** `manifest.json` stays in its base language and
  unchanged apart from two optional fields: `language` (the base, a BCP
  47 tag, default `en`) and `languages` (the tags of the language files
  present, since a page opened from disk cannot list a folder). Older
  players ignore both and play the base. `schemaVersion` stays 1.
- **One language file per language**, `lang/<tag>.json`, with a
  generated `lang/<tag>.js` beside it so it loads from disk as
  `manifest.js` does. Only the chosen language loads. It holds the
  `language` tag (equal to the file name), an optional `name` (else the
  player names the language with `Intl.DisplayNames`), `title`,
  `version`, `items` (item id to its text), `speakers` (the manifest's
  speaker string to the name drawn), `decisions` (decision id to its
  `prompt` and route id to `label`), optional recorded `voice` lines
  with their tracks, and `keepOriginalVoice`. Every translated string
  records a short hash of the base text it was made from, so the
  validator can say which translations are stale. Nothing else is
  translatable: `thought`, media, timing, branches and ids stay the
  manifest's.
- **One item, one text.** A translation never splits an item over
  several screens or merges items. Saves, bookmarks, `#start`, the seen
  set and progress stay per item, so switching language redraws the
  current screen and keeps everything.
- **Speakers stay keys.** The manifest's `speaker` remains the identity
  (the `voices` keys, tools); the language file's `speakers` table
  changes only what is drawn. Uppercase speaker names follow the shown
  language (Turkish `i` becomes `İ`).
- **A stale translation** (its base text changed since) still shows in
  play; the validator warns, and the next PO export marks it for review.
- **The player's language** (the user, 2026-11-17, replacing the
  orchestrator's first rule) follows the reader's system (or app, or
  browser) language when the catalogue has it, otherwise English. The
  Language control changes the story only, never the controls: a pick
  of the original language had pinned the controls to it over a per-app
  language. So a reader of a game with one language still gets controls
  in their own language.
- **Catalogue languages** (39, English included): Arabic, Bulgarian,
  Catalan, Chinese (Simplified and Traditional), Croatian, Czech,
  Danish, Dutch, English, Finnish, French, German, Greek, Hebrew, Hindi,
  Hungarian, Indonesian, Italian, Japanese, Korean, Malay, Norwegian
  Bokmål, Persian, Polish, Portuguese (Brazil and Portugal), Romanian,
  Russian, Slovak, Spanish (Spain and Latin America), Swahili, Swedish,
  Thai, Turkish, Ukrainian, Urdu and Vietnamese. Agents write the drafts;
  each PO file says in its header that it is an unreviewed draft, and
  CREATE.md invites corrections. A language whose text a system font
  on macOS or Windows cannot draw, or whose words do not fit the
  screens, is dropped and listed in its item's evidence note.
- **Reading time per language.** The hold rule counts code points, so a
  Chinese line would get about a third of an English line's time for the
  same meaning. The player scales `msPerChar` by a per-language factor
  from its own table, measured from the corpus example's parallel
  translations (characters per language against English, as the
  feasibility note measured Chinese at 0.37). Languages not in the table
  use 1.

1. The format. Schema for the manifest's `language` and `languages` and
   for a language file (`lang.schema.json`); docs/content-format.md, a
   "Translations" section; `types.ts`; the validator: each language file
   and its `.js` agree; the tag matches the file name and the
   manifest's list; a file the list names exists; an unknown item,
   decision, route or speaker is an error; an empty text is an error;
   a prompt of 200 characters or more, or a label of 120 or more, is an
   error; a missing string is a warning, with coverage per language; a
   stale string (base hash differs) is a warning; a text over 1.5x its
   base, or longer than the game's longest base text, is a warning;
   recorded voice tracks check as tracks do. `fixtures/build_lang_demo.py`
   builds the gitignored `fixtures/lang-demo` from the demo's manifest
   and media with three language files (German, Japanese and Arabic),
   one missing line, one stale line, a speaker table, a translated
   prompt and labels. Tests: validator cases for each rule, the demo and
   the language demo validate, `tools/test_build_lang_demo.py`,
   manifest.test.ts.
2. The player's words in a catalogue, English only. Every reader-visible
   string the player draws (render/*.ts, `wording.ts`'s browser and app
   wordings, accessible names, pills, the confirmation boxes) comes from
   one catalogue by key, with English in TypeScript and other languages
   compiled at build time from PO files under `player/locales/`.
   Plurals by `Intl.PluralRules` categories, numbers by
   `Intl.NumberFormat`. Key-cap labels (Space, Tab, Esc, Enter) stay as
   keyboards print them. A pseudo-locale (every string wrapped and made
   40% longer) exists for tests only. Tests: unit tests of lookup,
   plurals and fallback; a scenario walking every screen and sheet in
   the pseudo-locale that fails on any visible text outside the markers
   or any text overflowing its box, Chrome and WebKit; the existing
   scenarios unchanged in English.
3. Choosing and showing a game's language. The player reads `language`
   and `languages`, picks the starting language as decided (matching
   `navigator.languages` by `Intl.Locale`, so `zh-TW` takes `zh-Hant`
   and `es-MX` takes `es-419`), loads `lang/<tag>.js` by script tag, and
   draws text, speaker names, prompts, labels, title and version through
   it, falling back to the base per string. `lang` (and `dir`) are set
   on the band, the choice screen, the end card and the map's labels,
   per string, so a fallback line carries the base language's tag. The
   title-bar Language control as decided: keyboard reachable, arrows
   move in the open list, Enter or a click picks, Escape closes the list
   only; switching redraws the current item, keeps position, picks, the
   seen set and auto-forward; the choice persists per `storyId` and
   survives a reload. Per-language reading time as decided. The
   system font stack per writing system (`:lang()` rules for Chinese,
   Japanese, Korean, Arabic, Hebrew, Thai and the Indian scripts, with
   the macOS and Windows system faces), and thoughts in those scripts
   drawn upright, told apart by colour alone, since their fonts have no
   italic. Tests: unit
   tests of matching and fallback; a `languages` scenario file on the
   language demo: the control absent in the demo and present in the
   language demo with the Esc panel the same height in both at 1280x800
   and 600 wide, switching on an item and at a decision, a bookmark
   restore landing on the same item in each language, reload keeping
   the language, the missing line showing the base, a Turkish-style
   uppercase check, Chrome and WebKit.
4. The player's words in every catalogue language. The 38 other PO
   files of the decided list, written as drafts and marked so;
   `npm test` checks every catalogue is complete with matching
   placeholders. The player's language follows the decided rule and
   changes with the Language control. Tests: the item 2 scenario run in
   each catalogue language at 1280x800, 700x600 and 600 wide (no
   overflow, no clipping, no text outside the catalogue), Chrome and
   WebKit; a language that cannot pass is dropped and listed.
5. Right to left. `dir="rtl"` on the document for Arabic, Persian,
   Hebrew and Urdu (catalogue or game text); `index.html`'s CSS moves to
   logical properties (start and end, not left and right) so the Esc
   screen, help, Volumes sheet, end card, pills, choice list and band
   mirror; switches, sliders and the speed steps read right to left; the
   branch map's layout stays as it is, its labels right to left; arrow
   keys keep their physical meaning. Tests: an `rtl` scenario file
   (mirrored geometry: Keys at the right of Settings, the Language
   control at the left of the title bar, the slider's minimum at the
   right; no overflow) in Arabic and Hebrew, Chrome and WebKit, and the
   existing scenarios unchanged left to right.
5b. The route pill and the end card, and Arabic-script asides (leads
   from item 5). On an ending the route pill ("Route 2: an ending")
   draws over the end card's box at the top of the screen, in every
   direction; they must not overlap at any window size (stack them, or
   move one). The end card's hint and the resume notice (`.ui-aside`)
   are italic in Arabic, Persian and Urdu, whose faces have no italic,
   so the browser slants them: draw them upright there, as for Chinese,
   Japanese and Korean. Tests: a scenario check that the pill and the
   end card's boxes do not intersect at 1280x800, 700x600 and 600x900,
   Chrome and WebKit; the `uilanguages` style check extended to ar, fa
   and ur.
6. Spoken lines per language. The player passes the shown language to
   the voice helper for live lines, and speaks nothing live in a
   language the engine lacks; a language file's own recorded lines play
   in that language; with `keepOriginalVoice` the base recordings play
   under it, and without it they do not. `tools/record_lines.py --lang
   TAG` records a language's lines into its language file. The helper's
   cache key already includes the language; confirm it. Tests: helper
   tests with the fake engine for `lang`; record_lines tests for
   `--lang`; the `spoken` scenario file extended (the stand-in host
   receives the shown language; base recordings silent under a
   translation without `keepOriginalVoice`, playing with it), Chrome
   and WebKit, and `machost` on WebKit.
6b. Sound controls per language, and base recordings in the base
   language (leads from item 6). The Sound row, the Volumes...
   button and `v` are decided at boot from the base and the starting
   language only: a language with voice where neither has sound gets no
   button, and a language with no sound opens an empty sheet. Decide
   them from what the shown language can play, live on a switch (rows,
   the button, `v`, and the Keys row for `v`). `record_lines.py`
   without `--lang` records in the helper's default `en`; record base
   lines in the manifest's `language` (refusing a base language the
   engine lacks). A game whose every line in every language is recorded
   creates no voice client, so it sends the host no `status`. Tests:
   unit tests of the per-language sound content; `spoken` and `audio`
   scenario checks on copies with sound in only one language, Chrome and
   WebKit; record_lines tests for a German-base game.
7. The game apps. The page tells the host its language
   (`{type: "language", tag, dir}` through `send`); the Mac app retitles
   its menu items and window title from a table the build generates
   from the catalogue; the Windows program retitles its window. The
   dialogs either app shows before the page loads use the system
   language from the same table. Tests: build_apps tests (the table
   embedded), the Go tests for the Windows message, a `machost`
   scenario part for the Mac message, WebKit.
7b. The Mac app's per-app language (the user, 2026-11-17, checking the
   demo). macOS System Settings, Language & Region, Applications, says
   the game app "doesn't support additional languages", because its
   Info.plist declares none. Declare the catalogue's languages
   (`CFBundleLocalizations` from `apps/host-words.json`'s languages,
   in the forms macOS lists, and `CFBundleDevelopmentRegion` `en`), so
   a reader can give the app its own language there; the page's
   `navigator.languages` and the menus then follow it. Tests:
   build_apps tests (the keys present, matching the catalogue); a
   driver check that a per-app language preference reaches the page.
7c. The controls follow the system language only (the user,
   2026-11-17, after an explicit pick of English kept the demo app's
   controls English under a per-app Chinese). `uiLanguageFor` ignores
   the reader's pick: the best catalogue match of the system languages,
   else English. A pick changes the story's text, speakers, prompts,
   labels and title, and its per-string `lang` and `dir`, not the
   controls, the document's `lang`/`dir` or the host's `ui`. Tests:
   unit tests of the rule; the `languages`, `rtl` (its live part: a
   pick of Arabic turns the story right to left and leaves the screen
   left to right), `uilanguages` and `machost` expectations; docs that
   describe the rule.
8. The translator tools. `tools/translations.py export <folder> TAG`
   writes `<tag>.po` with one entry per item text, speaker, prompt,
   label, title and version: the id as `msgctxt`, the base text as
   `msgid`, and as comments the speaker, the item's type, the previous
   and next two lines, the decision and route, and the base length.
   Exporting a language that already has a file merges: translations
   kept, new strings added, stale ones marked fuzzy. `import <folder>
   FILE.po` writes `lang/<tag>.json` and `.js`, records base hashes,
   adds the tag to `languages` and regenerates `manifest.js`; a fuzzy
   entry imports as stale. `status <folder>` prints coverage and stale
   counts per language. `kinetic_extract/schema_copy.py` also copies
   `lang.schema.json` into a folder that has language files (a lead
   from item 1). A pinned pure-Python PO library or our own
   reader, as the item's tests decide. Tests:
   `tools/test_translations.py`: export, import of a translated file
   that then validates, re-export after a base change marking fuzzy, an
   unchanged round trip reproducing the file, Poedit-style line
   wrapping read back, refusal of a PO for another game.
9. kinetic-extract reads Ren'Py translations. Dialogue blocks under
   `game/tl/<lang>/` matched to items by Ren'Py's translation
   identifier (the label and the hash of the say statement, computed as
   Ren'Py computes it), `translate <lang> strings` blocks for menu
   choices and character names, a language-tag table for Ren'Py's
   folder names (`zhCN` to `zh-Hans`, `ptBR` to `pt-BR`, `esLT` to
   `es-419`, `None` skipped), and `--language-map` for others;
   `keepOriginalVoice` set when the game has `voice` statements; style
   blocks and file replacements ignored and counted in the report.
   Lines merged into one item join their parts' translations. Tests: a
   `tl/de` folder added to `fixtures/renpy_demo` with dialogue, strings
   and a style block; converter tests of identifier matching, the tag
   table, coverage and the report; a read-only real check on the corpus
   example (coverage per language in the evidence note, the game not
   named).
9b. Converter leads from item 9. (a) An `extend` line becomes an item
   of its own whose speaker is drawn as "extend": append it to the
   previous say's item, as Ren'Py shows it (this changes output only
   where today's is wrong; list any changed item ids in the evidence).
   (b) `define x = Character(_("Name"))` and similar wrapped names are
   read as the display name, so `strings` blocks can translate speakers.
   (c) `--base-language TAG` names a game's own language (written to the
   manifest's `language`), so a game written in another language that
   ships `tl/english` gets an English language file. (d) A block whose
   English changed since translation is kept, with `from` set to the
   hash of the old English in its commented code, so it shows as stale
   instead of being dropped. (e) `tl/` scripts inside `.rpa` archives
   are read (compiled-only `.rpyc` stay counted, not read). Tests:
   synthetic converter cases for each; the demo's golden output updated
   only where (a) changes it.
9c. Archive script pairs and concatenated names (leads from item 9b).
   An `.rpa` archive holding both `x.rpy` and `x.rpyc` has both walked
   (`rpa.script_entries` drops only exact duplicates), duplicating the
   story and costing a decompile; prefer the `.rpy`, as for loose files.
   Item 9b made `Character("Ana" + x)` give the variable name where it
   used to give "Ana": restore the leading literal for such
   expressions. Tests: synthetic converter cases; a read-only timing
   check of the corpus game whose walk did not finish in 10 minutes.
9d. Asset lookup speed and walk-scope consistency (leads from item
   9c). `AssetArchives.candidates` scans every key of every archive
   twice per lookup (about 0.2 s a call; 84 of 85 s in a profiled
   slice): build an index by stem and base name once. A loose script
   in a subfolder of `game/` is never walked (the walk is top-level
   only) yet shadows an archived script with the same key, and item 9's
   translation identifiers read it: only walked scripts may shadow or
   feed identifiers. `--files "*.rpy"` excludes archived `.rpyc`
   members but maps to `*.rpyc` for loose ones: make archives follow
   the loose rule. Tests: synthetic converter cases; the walk timing of
   item 9c's corpus game again.
10. Tools and docs around it. `check-game --lang TAG` walks with that
    language shown and reports fallbacks and stale lines met;
    `tools/assemble_folder.py` and `tools/upgrade_folder.py` carry
    `lang/`; docs/packaging.md. CREATE.md gains "Translating a game":
    the author's flow, a contributor's flow (Poedit, or Weblate or
    Crowdin for a project online), Ren'Py translations, what readers
    see, and how to correct the player's own catalogue. Tests:
    check-game tests for `--lang`, assemble and upgrade tests for
    `lang/`.
11. Phase-closer: full suites; VERSION 1.11.0, the CHANGELOG dated, tag,
    `main` fast-forwarded.

Sequencing: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11,
serial. Items 8 and 9 need only item 1 and may run before 3 if the
player items stall.

## Phase 57: An installable toolchain, and checks for agent conversions (2026-11-17, user)

The user asked which docs/future.md entries would help an agent convert
an existing Ren'Py game, then scheduled the useful parts: the author
checks an agent can read (a report per game, the route structure as
text, a proofreading export), the Ren'Py presentation a conversion
loses today (speaker colours, emphasis, crossfades, plus a documented
title and credits pattern), and the installable toolchain with a
Windows ffmpeg pin. Parts that serve only a person stay in
docs/future.md: the video range picker and the route graph drawn as a
page or SVG. The entries "Installable toolchain and Windows authoring"
and "Text and presentation" are removed from there; "Author checks and
helpers" keeps the person-only parts. Fonts stay unwanted (docs/future.md,
"Not wanted").

The repo moved to the public `sendub/kinetic` on 2026-11-17, so a
release download needs no sign-in.

The user's decisions (2026-11-17):

- **Installed from a wheel attached to each GitHub release**, with
  `pip install <release-url>`. The phase-closer builds the wheel and
  attaches it to the release from now on.
- **`kinetic check` runs check-game with the system Node.** The wheel
  carries check-game with puppeteer-core bundled into one file, so no
  `npm ci` and no clone; Node and Chrome (or the WebKit driver on
  macOS) stay prerequisites.
- **Emphasis is Ren'Py's own text tags.** The player honours `{i}`,
  `{b}`, `{u}` and `{s}` with their closing tags; `{{` is a literal
  brace. It drops the tags that only time the text (`{w}`, `{w=N}`,
  `{nw}`, `{fast}`, `{cps=N}`), shows `{p}` as a line break, and keeps
  the inner text of any other tag (`{size}`, `{font}`, `{a}`,
  `{color}`). Converted folders already hold these tags literally, so
  upgrading their player is enough. An older player shows the braces,
  as it does today.
- **Crossfades are set per item, in two kinds**: an optional
  `transition` on a visual item, `{"kind": "dissolve", "seconds": S}`
  or `{"kind": "fade", "out": S, "hold": S, "in": S}` (through black).
  The converter maps Ren'Py's `dissolve`, `Dissolve(t)`, `fade` and
  `Fade(out, hold, in)`; any other transition becomes a cut and is
  listed in the conversion report.
- **The Windows ffmpeg pin must match the shared goldens.** No pinned
  publisher builds Windows, so the item tries ffmpeg 9.0.2 builds from
  other publishers (gyan.dev, BtbN) on the user's Windows PC and pins
  the first whose self-test matches every existing golden. If none
  does, the item stops and reports to the user, who may then allow
  per-platform goldens.
- **The orchestrator records new pins**, under rules AGENTS.md gains:
  only by running `--pin` on that platform, only when the download
  matches the publisher's checksum, only while every shared golden
  matches, and listing every hash recorded in the evidence note. This
  phase pins Windows and linux-x86_64 (WSL on the same PC);
  linux-arm64 stays null with a setup error saying so. `macos-x86_64`
  is dropped: Intel Macs are not supported, as the Mac app is already
  arm64 only.
- **The apps come from prebuilt hosts in the wheel**, so making them
  needs no Swift or Go. Each release builds the Mac host and the
  Windows host once; `kinetic apps` writes each game's title, storyId
  and icon into its copy. The hosts read those settings at launch,
  which costs well under a millisecond and nothing afterwards (the Mac
  from Info.plist, which macOS reads anyway; the exe from one small
  resource).

The orchestrator's choices, within those decisions:

- **One command, old names kept.** `kinetic` has subcommands `setup`,
  `extract`, `media` (`ship`, `rebuild`, `posters`), `validate`,
  `assemble`, `apps`, `upgrade`, `check`, `report`, `routes`, `export`
  and `--version`. `kinetic-extract`, `kinetic-media` and the
  `tools/*.py` scripts keep working as thin wrappers, so existing
  agent notes and folders' instructions stay true.
- **Checks print for an agent.** `report`, `routes` and `export` write
  plain text by default and JSON with `--json`; none opens a page.
- **Speaker colours**: an optional top-level `characters` table, keyed
  by the manifest's `speaker` string, each with optional `nameColor`
  and `textColor` as `#rrggbb`. A language file's `speakers` table
  changes only the name drawn, so a translated name keeps its colour.
  The converter fills the table from `Character(...)`'s literal
  `color`, `who_color` and `what_color`.
- **Reading time counts what is shown.** The hold rule
  (docs/content-format.md, "Timing") counts the code points left after
  the tags are read, not the tags.
- **Transitions never delay navigation or text.** The item's text and
  speaker show at once; only the picture under them changes over time.
  Skip, the wheel, back, jumps (map, bookmark, `#start`) and
  `prefers-reduced-motion` cut. A key pressed during a transition ends
  it at once and moves on. Auto-forward's hold starts when the item
  shows, as now.
- **Version.** New optional manifest fields, so the phase closes as the
  minor 1.12.0; `schemaVersion` stays 1.

1. The format. Schema, docs/content-format.md, `types.ts` and the
   validator for `characters` (`nameColor` and `textColor` as
   `#rrggbb`; a key no item's `speaker` uses is a warning; a colour
   whose contrast with the text band is below 4.5:1 is a warning),
   `transition` on `image`, `animation` and `video` items (`dissolve`
   seconds above 0 and at most 5; `fade` parts each 0 to 5, with `out`
   or `in` above 0; any other kind is an error), and text tags in
   `text`, prompts, labels and language files (an unknown or unclosed
   tag is a warning; a tag never makes a text invalid). Content-format
   gains a "Text tags" section with the table of tags and what the
   player does with each, and "Timing" says the count excludes tags.
   `fixtures/build_demo.py` gains a coloured speaker, a line with
   `{i}` and `{b}`, a dissolve and a fade. Tests: validator cases for
   each rule; the demo validates.
2. The player draws tags and colours. Emphasis is built as DOM
   elements from the parsed tags, never through HTML; timing tags go,
   `{p}` breaks the line, other tags leave their inner text. Lines,
   prompts, route labels and language-file text all go through the
   same parser; the branch map, the end card and the help draw the
   plain text. Speaker colours apply to the name and the line, the
   thought style still distinguishes thoughts, and right-to-left text
   keeps working. Reading time counts shown code points. Tests: unit
   tests for the parser (every tag in the table, nesting, unclosed and
   unknown tags, `{{`, right-to-left text); scenario checks in Chrome
   and WebKit that italic and colour reach the page and no brace shows
   on the demo.
2b. Spoken lines say the shown text (item 2's lead). `spokenLine` in
    `player/src/render/spoken.ts` and tools/record_lines.py send the
    raw text, tags included, to the voice engine and use it as the
    cache and recording key. Both switch to the shown text (tags read,
    `{p}` a pause or space) together, so live lines still match
    recorded ones; a folder recorded before keeps working or the
    validator says to re-record. Tests: unit tests on both sides with a
    tagged line; the `spoken` scenario on Chrome and WebKit.
3. The player's transitions. `dissolve` fades the new picture in over
   the old; `fade` takes the old to black over `out`, holds, and brings
   the new in over `in`, all on the compositor (opacity only). The new
   item's first paint stays inside the 41 ms budget, the rules under
   "Transitions never delay navigation or text" hold, and a video's
   playback starts at once under its fade. Tests: unit tests for the
   rules (each cut case, a key during a transition, reduced motion);
   scenario checks in Chrome and WebKit; `npm run perf` navigation p95
   within noise of 1.11.0.
4. The converter carries Ren'Py's presentation. Character colours from
   literal `color`, `who_color` and `what_color` (`#rgb`, `#rrggbb`,
   and `#rrggbbaa` with its alpha dropped) into `characters`; text tags
   stay in the text as now. `with` clauses and statements (`scene x
   with dissolve`, a bare `with fade`, `show ... with`) give the next
   visual item its `transition`, for `dissolve`, `fade`, `Dissolve(t)`,
   `Fade(out, hold, in)` and `define`d names bound to those calls;
   `with None` and every other transition give a cut, counted by name
   in the conversion report. docs/extracting.md says how each maps.
   Tests: synthetic converter cases for each form; a read-only run on
   two corpus games reports how many lines got colours and how many
   transitions mapped or were cut, in the evidence note without naming
   the games.
4b. Ren'Py's script walk (item 4's corpus run). Both corpus games keep
    their story in subfolders of `game/`, which the walk skips unless
    `--files` reaches them (docs/extracting.md, "Which scripts are
    walked"), though Ren'Py loads every script under `game/`. Walk loose
    `.rpy`/`.rpyc` in subfolders by default, as Ren'Py does, keeping
    `tl/` out and the one-source-per-path rules; `--files` still
    narrows. Tests: synthetic walk cases; the two corpus games convert
    with no `--files`.
4c. Old-style characters (item 4's corpus run). Characters made in
    `init:` blocks and `$ e = Character(...)` lines give the same names
    and colours as `define`, and a Character with no name argument takes
    its `kind=`'s name, as Ren'Py does. Tests: synthetic cases.
4d. A corpus game's lost pictures (item 4's corpus run). Game 1's scenes
    mostly resolve to no image (3576 visuals dropped). Find the cause in
    the image lookup and fix it in general, not for that game. Tests: a
    synthetic case of the cause; game 1's dropped count after the fix.
4e. The walk follows labels (item 4d's corpus run). The converter joins
    the walked scripts in file-name order, so lines in non-story scripts
    (a developer script, minigames) become items, and a game whose
    story order differs from its file order reads out of order; one
    corpus game gets 37 validator errors from text before any picture.
    Read the story as Ren'Py runs it: from `label start` through
    `jump`, `call` and fall-through to the next label in the same file,
    taking only reached labels' statements; unreached labels are
    reported, not emitted. Keep `--label` working. Tests: synthetic
    projects with story order unlike file order, a call and return, an
    unreached developer label; the two corpus games before and after.
4f. Python-picked scenes read in place (item 4e's follow-up). Every
    computed `jump/call expression` site draws on one shared list of
    labels named in the game's code, so the first site the walk reaches
    takes all of them (one corpus game reads 30 nightly scenes at a
    gallery-replay call). Give each candidate to the site its name is
    most tied to: a site whose own expression or the Python that sets
    its variable (the same label or init block, a function it calls)
    names it, else the nearest site in the same file, else the first.
    Tests: synthetic projects with two computed sites and their own
    candidate sets; the corpus game's scenes land at the nightly call.
5. `kinetic report <folder>`. Reading time per route from "Timing",
   speakers with line counts (names that differ only in case,
   spacing, or by one letter are flagged), files in the folder no item
   or track uses, the 20 longest lines by shown characters, and the
   unknown tags met. `check-game` also reports a line whose text
   overflows its band at the folder's size, measured in the page during
   the walk, since an agent cannot see the screen. Tests: report tests
   on a synthetic folder with each finding; a check-game test with an
   overflowing line.
6. `kinetic routes <folder>`. The branch structure as an indented
   outline: each decision with its prompt, each route with its label,
   item count, first and last item ids, and where it ends or rejoins;
   `--dot` prints Graphviz DOT; `--json` the same model. It follows the
   branch map's model (`player/src/render/mapmodel.ts`) and the
   validator's reachability, and a test keeps their route counts equal
   on the fixtures. Tests: outline, DOT and JSON on the demo and on a
   synthetic folder with nested decisions and rejoins.
7. `kinetic export <folder> [--lang TAG]`. Each route as Markdown:
   `Speaker: text` lines with tags read, choices with their labels,
   media file names as comments, and item ids as anchors, so an agent
   can lay a route beside its `.rpy` source. Tests: export of the demo
   and of `fixtures/lang-demo` in German.
7b. Decisions resolved in near-linear time (items 6-7's lead).
    `folder_model.resolve_decisions` works out nesting by comparing
    every decision with every other (5000 decisions take about 2 s) and
    `report.timing_section` scans for each decision's branch. Use an
    interval walk or index so validate, report, routes and export stay
    fast on games with thousands of decisions, same results. Tests: the
    existing ones unchanged; a 20,000-decision synthetic folder under a
    time bound.
7c. Malformed branches never hang a tool (item 7b's lead). The
    validator prints its problems and never exits when a `continueAt`
    lies before its routes: `reach_warnings` runs the `shown_by_play_all`
    walk even after `branches_problems` failed, and a backward join
    loops; `report._shortest_ms` loops the same way, and routes raises
    on an unhashable decision id. Skip the reading walks when branch
    problems exist (report, routes and export say the branches are
    malformed and exit 1 or 2 as fits), and guard the walks against a
    backward join. Tests: a malformed folder for each tool finishes
    under a time bound.
8b. Per-platform goldens (the user, 2026-11-17, after item 8 found that
    every x86_64 build, whatever its publisher, differs from the
    arm64 goldens on the same 6 cases: the CPU, not the build). A
    platform may hold its own golden for a case; every other case
    still matches the shared golden. `--pin` on a new platform records
    the archive checksums (publisher-checked) and that platform's own
    goldens for the cases that differ, refusing when a case fails to
    run or differs on more than the cases a CPU difference explains
    (the user approves any new differing case). The encode cache keys
    on the platform; the media ledger records the platform that made
    each output, and `kinetic media rebuild` on another platform says
    which platform can verify those outputs instead of reporting a bare
    mismatch. AGENTS.md's pin rule says so. The orchestrator then runs
    `--pin` on Windows and in WSL. Tests: setup tests for platform
    goldens and the refusal; cache and rebuild tests for the platform
    key; the self-test on Windows and WSL against their own goldens.
8. Media tools for Windows and Linux. Drop `macos-x86_64` from
   `converter/media-tools.json` and the docs. On the user's Windows PC
   over SSH (the user's global notes say how), try ffmpeg 9.0.2 builds
   from gyan.dev and BtbN and pin the first whose self-test matches
   every shared golden, recording the checksum only when it matches the
   publisher's; if none matches, stop and report the differing cases to
   the user. Pin linux-x86_64 in WSL on the same PC the same way.
   linux-arm64 keeps its null pin and setup says so. The media tools
   run on Windows (`.exe` names, paths with drive letters and spaces,
   process spawning). AGENTS.md's pin rule is rewritten as the user
   decided. Remove what was installed on the PC afterwards. Tests:
   setup tests for the Windows platform key and the null-pin message;
   the self-test and a demo conversion on Windows and in WSL, in the
   evidence note.
9. The `kinetic` command and the wheel. A package holding the
   subcommands above (the converter, the tools moved in, the old names
   as wrappers), the built player bundle, the schemas, and check-game
   bundled with puppeteer-core by esbuild into one file run by the
   system Node (a clear error names the Node version needed when it is
   missing or old). `tools/build_wheel.py` builds the wheel from a
   clean `npm run build`. Tests: a wheel test that installs into a
   fresh venv under `.tmp/` and runs every subcommand's `--help` and
   `kinetic check` on the demo in Chrome.
10. Prebuilt app hosts. The Mac host reads storyId and title from its
    Info.plist and the Windows host from an RCDATA settings resource,
    in place of values compiled in. The release build compiles both
    once into the wheel (the WebKit driver too, so `kinetic check` uses
    WebKit on macOS without Swift). `kinetic apps` copies them: for the
    Mac it writes Info.plist and the icon and signs the bundle ad hoc
    with `codesign` (so the Mac app still needs macOS); for Windows it
    rewrites the exe's resources (icon, version, settings) from any OS,
    extending `tools/windows_resources.py`, with the release build
    keeping `.rsrc` as the exe's last section so it can be replaced.
    Both hosts gain a `--self-check` that prints their settings and
    exits without a window. Tests: Swift and Go tests for reading the
    settings; Python tests that a rewritten exe parses and reads back
    its resources; `--self-check` on a built Mac app and, over SSH, on
    the Windows PC; apps built from the wheel with no Swift or Go on
    PATH.
11. Release and install docs. CREATE.md is reorganised around
    `kinetic`: installing from a release, converting a Ren'Py game with
    `report`, `routes`, `export` and `check` as the agent's checks, the
    text tags, speaker colours and transitions, and the title, credits
    and content warnings pattern (image and text items at the start or
    end, no new screens). AGENTS.md's Commands section and README.md
    follow, and AGENTS.md's Versions paragraph gains the closer's wheel
    step: build the wheel and attach it to the release with the
    `sendub` account. `package-proof` gains a wheel stage: install the
    wheel in a fresh venv, run setup, convert the extract demo, report,
    check and build both apps. Tests: package-proof.
11b. The validator for gates (a converting agent's request, 2026-11-17;
    the user chose silent-when-clean). The agent runs the validator as
    a gate, "exit 0 and empty output", which a game with languages can
    never pass: every run prints a coverage line per language, even at
    100%, and warnings cannot fail the exit status. A plain run prints
    only problems and warnings, so a clean folder prints nothing; the
    per-language coverage lines move to `kinetic report` (a section with
    strings, missing, stale, unchecked and long per language, in text
    and `--json`). `--strict` makes warnings alone exit 3 (0 clean, 1
    problems, 2 bad arguments unchanged). `--json` prints problems,
    warnings by kind and per-language coverage as one JSON object on
    stdout, the exit status as without it. Applies to `kinetic validate`
    and the tools/validate_content.py wrapper alike. Tests: a clean
    language folder prints nothing and exits 0; `--strict` on a folder
    with only warnings exits 3, with problems 1; `--json` shape;
    report's coverage section; the demo builders and every test that
    reads the coverage text updated. CREATE.md, AGENTS.md and the
    CHANGELOG (an Upgrading bullet: coverage is in `kinetic report` or
    `validate --json`; gates can use `--strict`).
12. Phase-closer: full suites; VERSION 1.12.0, the CHANGELOG dated,
    tag, `main` fast-forwarded, and the wheel attached to the GitHub
    release v1.12.0.

Sequencing: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10 -> 11 ->
12, serial. Items 5 to 7 need only item 1, and item 8 needs nothing
before it, so either may move earlier if the player items stall.

## Sequencing

1 -> 2 -> 2b -> 3 -> 4 -> 5 -> 6 -> 7 -> 7b -> 8 -> 9 -> 9b -> 9c -> 9d ->
10 -> 11 -> 13 -> 12 -> 15, serial. The default is serial per the
single-slot model serving rule. Phase 12 (perf, packaging, final doc
pass) had run when Phase 15 (external tester) arrived; a final README
accuracy pass lands with Phase 15 completion.
