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

## Later, waiting on the user

- Overlay text styling iteration once the user can play with the demo.

## Sequencing

1 -> 2 -> 2b -> 3 -> 4 -> 5 -> 6 -> 7 -> 7b -> 8 -> 9 -> 9b -> 10 -> 11 ->
12, serial. The default is serial per the single-slot model serving rule.
