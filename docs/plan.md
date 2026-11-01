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

## Phase 2b: Format revision from external review (2025-11-01)

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

## Phase 7b: Presentation revision (2025-11-01, user requests)

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
  click resumes at that item, closing the overlay.
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

## Phase 9b: Media revision (2025-11-01, user requests)

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

## Phase 9c: Video playback ranges (2025-11-01, user requests)

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

## Phase 9d: Loop restart point (2025-11-01, user request)

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

## Phase 13: Author-defined branches (2025-11-01, user request)

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
  (2025-11-01, found by the extracted-demo walk): when a route of a
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
- `Play all routes` (new persisted setting, default off, in the `c`
  screen): zero interactivity. On reaching a decision, auto-pick routes
  in manifest order among routes not yet played (all seen -> pick the
  continuing route once, then past it); after a route completes, return
  to the decision and repeat until every route has played once, then
  continue via `continueAt`. `holdSeconds`/video/text timing rules
  unchanged. Works inside skip mode too.
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

## Phase 13b: Manual/auto mode clarity + key help (2025-11-01, external-user report + user clarification)

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

## Phase 15: Minimum video play time under chains (2025-11-01, external tester)

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

## Later, waiting on the user

- Overlay text styling iteration once the user can play with the demo.

## Sequencing

1 -> 2 -> 2b -> 3 -> 4 -> 5 -> 6 -> 7 -> 7b -> 8 -> 9 -> 9b -> 9c -> 9d ->
10 -> 11 -> 13 -> 12 -> 15, serial. The default is serial per the
single-slot model serving rule. Phase 12 (perf, packaging, final doc
pass) had run when Phase 15 (external tester) arrived; a final README
accuracy pass lands with Phase 15 completion.
