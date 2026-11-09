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
  non-kinetic games, e.g. game I ep3,
  `scenes/EP02_01/EP02_01_dialogues1_white.rpy:1679` in the corpus).
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

Another agent building a real timeline (game I corpus) reviewed
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

- Corpus: <corpus> holds many games organized by
  category (`<category>/`, `<category>/`) with `complete/`, `ongoing/`,
  `abandoned/`, and `waiting for updates/` subfolders, plus Mac `.app`
  bundles (`game-e.app`, `game-d.app`, ...) and `.zip`/`.rar`
  releases, some marked broken. Inspect and use it read-only.
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

Source: feedback from an agent converting games (game I),
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

The user, on the game I map at Full size: the routes of some
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
- The user picks between a and b on game I staged with each, with
  screenshots side by side; b lands only if chosen.

The user chose a (2026-11-08). b was built and compared: it removed 60-75% of
the low-held line length on game I but not all (a line stays low
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
  later `<img>` with the same URL reuses the result. On the "pay Rowan"
  stretch of game I, a 25 s Tab skip with "Play videos in full"
  off showed 97 of 275 pictures in WebKit before the change and 275 of 275
  after. Chrome went from 120 to 257 of 275.
- The scenario suite runs unchanged on WebKit through a WKWebView driver
  (`.tmp/webkit-driver/`). The driver uses an off-screen window and is
  configured the way the app configures its web view, so nothing appears on
  screen. On 66ce4dc: 325 checks, 319 pass, 3 PARTIAL (element fullscreen,
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
   synthetic machine test with ten items reproduced it on 66ce4dc. Press `a`
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

## Later, waiting on the user

- Overlay text styling iteration once the user can play with the demo.

## Sequencing

1 -> 2 -> 2b -> 3 -> 4 -> 5 -> 6 -> 7 -> 7b -> 8 -> 9 -> 9b -> 9c -> 9d ->
10 -> 11 -> 13 -> 12 -> 15, serial. The default is serial per the
single-slot model serving rule. Phase 12 (perf, packaging, final doc
pass) had run when Phase 15 (external tester) arrived; a final README
accuracy pass lands with Phase 15 completion.
