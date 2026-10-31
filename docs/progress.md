# Progress Checklist

Mirrors docs/plan.md. Implementers check items off in the same commit as
the work, append dated notes under a phase only when a check needs
evidence (test counts, measurement numbers, blockers), and keep this file
truthful: an unchecked box means nothing was accepted.

## Phase 1: Player scaffolding

- [x] `player/` initialized with TypeScript strict, esbuild, Biome, Vitest
- [x] Scripts `dev`, `build`, `test`, `check` all exit 0
- [x] `dist/index.html` opens over `file://` with no console errors
      (headless Chrome, stderr clean, 2025-11-01)

## Phase 2: Content format and demo fixture

- [x] docs/content-format.md written; JSON Schema file added
- [x] `fixtures/build_demo.py` produces `fixtures/demo/` reproducibly
      (byte-identical reruns, sha256-verified, 2025-11-01)
- [x] Validator passes on the fixture and fails on a broken manifest (in
      tests) (20 pytest tests, 2025-11-01)
- [x] Top-level CREATE.md written against the final schema (worked
      example validated against the real validator, 2025-11-01)

## Phase 2b: Format revision from external review (2025-11-01)

- [x] docs/content-format.md timing formula fixed to all-ms units; `text`
      items and media reuse documented; CREATE.md synced (formula matches
      machine defaults, 2025-11-01)
- [x] Schema `text` variant; validator rules and new fault tests green
      (24 pytest tests, 2025-11-01)
- [x] Machine `text` items: text-only holds, media loops under chains,
      cursor-to-visual helper; tests green (34 tests, 2025-11-01)
- [x] Demo fixture extended with video+text and image+text chains; all
      suites green (determinism sha256-verified, 2025-11-01)

## Phase 3: Timeline machine - core

- [x] Manifest model, cursor, frontier, advance, auto-advance implemented
- [x] Wheel-back / wheel-forward rules with frontier guard
- [x] README advance / auto-advance / scroll bullets each map to named
      tests; `npm test` green (22 machine tests, 2025-11-01)
- [x] Machine modules DOM-free (durable guard test `dom-free.test.ts`
      scanning sources, 37 tests, 2025-11-01)

## Phase 4: Timeline machine - skip and jumps

- [x] Tab skip mode: fixed rate, first frame only, frontier stop
- [x] `skip_all` setting honored
- [x] `e` jump targets the item before the frontier
- [x] Mode-transition tests (space/wheel cancel skip) green (8 new tests;
      resume semantics aligned to README, 2025-11-01)

## Phase 5: Player shell rendering

- [x] Manifest loader + machine wiring + image renderer (render/ layer,
      61 tests, 2025-11-01)
- [x] Text and speaker overlay; `h` toggles text
- [x] First keypress/click enters fullscreen
- [x] docs/verify-player.md written; walked on the demo fixture in Chrome
      (driver `player/scripts/verify.mjs`, 12 steps: 11 pass, 1 partial
      [real fullscreen visual not headless-observable], 2025-11-01)

## Phase 6: Animation and video rendering

- [x] Animations loop at manifest fps for the manifest count
- [x] Videos: poster to first paint, muted autoplay, `ended` feeds machine
- [x] Rewind and skip show first frame / poster, never play (unit-tested
      pure mode + poster still verified; wheel gesture lands in Phase 7)
- [x] Checklist extended and walked (verify.mjs 15 steps: 13 pass, 2
      honest partials [fullscreen effect, wheel gesture], 2025-11-01)

## Phase 7: Wheel scroll wiring

- [x] Wheel steps map to machine commands with debounce (pure wheelPlan,
      100px/step + 80ms cap; tab/e wired too, 2025-11-01)
- [x] Combined flow verified: space, tab, wheel, e, reload-resume
      (verify.mjs 21 steps, reload-resume honestly PARTIAL pending
      Phase 8 storage, 2025-11-01)

## Phase 7b: Presentation revision (2025-11-01, user requests)

- [x] Fill-the-screen contain-fit documented (README/content-format) and
      applied to images, animation frames, and video (verify geometry
      step 21 PASS, 96 tests, 2025-11-01)
- [x] `thought` field in format, schema, validator (fault tests), and
      CREATE.md (28 pytest tests, 2025-11-01)
- [x] Demo fixture gains a thought line (line-008, line-011; determinism
      sha256-verified, 2025-11-01)
- [x] Renderer: `data-mode` attribute + CSS-only speech/thought
      distinction; verify steps for mode and contain-fit geometry
      (23 steps: 21 pass, 2 honest partials, 99 tests, 2025-11-01)

## Phase 8: Bookmarks

- [x] Canvas thumbnail capture for image, animation, and video items
      (capture.ts + thumbSize tests; NOTE file:// taints canvas in
      Chrome - list falls back to manifest-based stills, 2025-11-01)
- [x] `b` appends timestamped bookmark to IndexedDB with confirmation
      (#flash, content-keyed, PASS headless over file://, 2025-11-01)
- [ ] `t` overlay: scroll list bottom-first; click resumes and closes
- [x] Reload restores bookmarks, frontier, resume position (verify step
      21 PASS at frontier-1; debounced frontier persistence + flush,
      2025-11-01)
- [x] Storage interface faked in machine tests (memory+noop contract
      suite, 125 tests, 2025-11-01)

## Phase 9: Config screen

- [ ] `c` overlay with reading speed and `skip_all`
- [ ] Settings persist to IndexedDB and apply live
- [ ] Machine-side config tests green; checklist walked

## Phase 10: Ren'Py extractor MVP

- [ ] `converter/` package with CLI over source `.rpy` projects
- [ ] Statement subset parser; unknown statements reported, not fatal
- [ ] Asset pass: Pillow derivatives, ffmpeg H.264 + posters
- [ ] Content-sniffed formats (never extension); wrapped/obfuscated images
      decoded to standard formats at conversion
- [ ] Identical sources deduped into shared derivative files
- [ ] `build-ledger.json` written as an unreferenced extra; validator
      tolerance tested
- [ ] `fixtures/renpy_demo/` + golden-manifest pytest green
- [ ] Extracted demo plays end to end in the player

## Phase 11: Extractor completeness on the real corpus

- [ ] Several distinct kinds sampled from <corpus>
      (`.app`, loose dir, zip; `.rpy` and `.rpyc`-only; `.rpa`; `.rpak`
      if present), a few random slices each
- [ ] unrpyc vendored and pinned; `.rpyc`-only projects decompile
- [ ] `.rpa` reader implemented
- [ ] Every sampled slice extracts and plays in the player
- [ ] docs/extracting.md has a per-game entry incl. what was skipped
- [ ] New parser branches covered by pytest

## Phase 12: Performance, packaging, docs

- [ ] ImageBitmap preload with LRU cache in the renderer
- [ ] Perf harness output recorded here; p95 navigation < 41 ms (or a
      documented revisit-trigger note)
- [ ] Self-contained novel folder plays by double-clicking `index.html`
      over `file://`
- [ ] docs/packaging.md written; Tauri path noted, not built
- [ ] README accuracy pass; this file fully checked

## Later, waiting on the user

- [ ] Overlay text styling iteration (incl. thought vs dialogue look)
      with the user, once a playable demo exists
