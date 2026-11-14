# Progress Checklist

Mirrors docs/plan.md. Implementers check items off in the same commit as
the work, append dated notes under a phase only when a check needs
evidence (test counts, measurement numbers, blockers), and keep this file
truthful: an unchecked box means nothing was accepted.

## Phase 1: Player scaffolding

- [x] `player/` initialized with TypeScript strict, esbuild, Biome, Vitest
- [x] Scripts `dev`, `build`, `test`, `check` all exit 0
- [x] `dist/index.html` opens over `file://` with no console errors
      (headless Chrome, stderr clean, 2026-10-31)

## Phase 2: Content format and demo fixture

- [x] docs/content-format.md written; JSON Schema file added
- [x] `fixtures/build_demo.py` produces `fixtures/demo/` reproducibly
      (byte-identical reruns, sha256-verified, 2026-10-31)
- [x] Validator passes on the fixture and fails on a broken manifest (in
      tests) (20 pytest tests, 2026-10-31)
- [x] Top-level CREATE.md written against the final schema (worked
      example validated against the real validator, 2026-10-31)

## Phase 2b: Format revision from external review (2026-10-31)

- [x] docs/content-format.md timing formula fixed to all-ms units; `text`
      items and media reuse documented; CREATE.md synced (formula matches
      machine defaults, 2026-10-31)
- [x] Schema `text` variant; validator rules and new fault tests green
      (24 pytest tests, 2026-10-31)
- [x] Machine `text` items: text-only holds, media loops under chains,
      cursor-to-visual helper; tests green (34 tests, 2026-10-31)
- [x] Demo fixture extended with video+text and image+text chains; all
      suites green (determinism sha256-verified, 2026-10-31)

## Phase 3: Timeline machine - core

- [x] Manifest model, cursor, frontier, advance, auto-advance implemented
- [x] Wheel-back / wheel-forward rules with frontier guard
- [x] README advance / auto-advance / scroll bullets each map to named
      tests; `npm test` green (22 machine tests, 2026-10-31)
- [x] Machine modules DOM-free (durable guard test `dom-free.test.ts`
      scanning sources, 37 tests, 2026-10-31)

## Phase 4: Timeline machine - skip and jumps

- [x] Tab skip mode: fixed rate, first frame only, frontier stop
- [x] `skip_all` setting honored
- [x] `e` jump targets the item before the frontier
- [x] Mode-transition tests (space/wheel cancel skip) green (8 new tests;
      resume semantics aligned to README, 2026-10-31)

## Phase 5: Player shell rendering

- [x] Manifest loader + machine wiring + image renderer (render/ layer,
      61 tests, 2026-10-31)
- [x] Text and speaker overlay; `h` toggles text
- [x] First keypress/click enters fullscreen
- [x] docs/verify-player.md written; walked on the demo fixture in Chrome
      (driver `player/scripts/verify.mjs`, 12 steps: 11 pass, 1 partial
      [real fullscreen visual not headless-observable], 2026-10-31)

## Phase 6: Animation and video rendering

- [x] Animations loop at manifest fps for the manifest count
- [x] Videos: poster to first paint, muted autoplay, `ended` feeds machine
- [x] Rewind and skip show first frame / poster, never play (unit-tested
      pure mode + poster still verified; wheel gesture lands in Phase 7)
- [x] Checklist extended and walked (verify.mjs 15 steps: 13 pass, 2
      honest partials [fullscreen effect, wheel gesture], 2026-10-31)

## Phase 7: Wheel scroll wiring

- [x] Wheel steps map to machine commands with debounce (pure wheelPlan,
      100px/step + 80ms cap; tab/e wired too, 2026-10-31)
- [x] Combined flow verified: space, tab, wheel, e, reload-resume
      (verify.mjs 21 steps, reload-resume honestly PARTIAL pending
      Phase 8 storage, 2026-10-31)

## Phase 7b: Presentation revision (2026-10-31, user requests)

- [x] Fill-the-screen contain-fit documented (README/content-format) and
      applied to images, animation frames, and video (verify geometry
      step 21 PASS, 96 tests, 2026-10-31)
- [x] `thought` field in format, schema, validator (fault tests), and
      CREATE.md (28 pytest tests, 2026-10-31)
- [x] Demo fixture gains a thought line (line-008, line-011; determinism
      sha256-verified, 2026-10-31)
- [x] Renderer: `data-mode` attribute + CSS-only speech/thought
      distinction; verify steps for mode and contain-fit geometry
      (23 steps: 21 pass, 2 honest partials, 99 tests, 2026-10-31)

## Phase 8: Bookmarks

- [x] Canvas thumbnail capture for image, animation, and video items
      (capture.ts + thumbSize tests; NOTE file:// taints canvas in
      Chrome - list falls back to manifest-based stills, 2026-10-31)
- [x] `b` appends timestamped bookmark to IndexedDB with confirmation
      (#flash, content-keyed, PASS headless over file://, 2026-10-31)
- [x] `t` overlay: scroll list bottom-first; click resumes and closes
      (goTo clamps to seen range, arrives unsettled; verify steps 21-23
      PASS incl. Escape-fullscreen quirk documented, 146 tests,
      2026-10-31)
- [x] Reload restores bookmarks, frontier, resume position (verify step
      21 PASS at frontier-1; debounced frontier persistence + flush,
      2026-10-31)
- [x] Storage interface faked in machine tests (memory+noop contract
      suite, 125 tests, 2026-10-31)

## Phase 9: Config screen

- [x] `c` overlay with reading speed and `skip_all` (z below flash,
      suspendTimeline shared gate, mutually exclusive with t)
- [x] Settings persist to IndexedDB and apply live (PersistedState
      settings field; setSettings re-arms current hold; reload keeps
      2.00x/ON in verify step 26)
- [x] Machine-side config tests green; checklist walked (163 tests, 29
      verify steps: 28 pass 1 known partial, 2026-10-31)

## Phase 9b: Media revision (2026-10-31, user requests)

- [x] Format/schema/validator/CREATE: video containers mp4|webm|mkv|
      mov|m4v and .jxl images; optional video `loopCount`/`holdSeconds`;
      naming `<id>.<ext>`; browser-support caveats documented (32 pytest
      tests, 2026-10-31)
- [x] Machine: video timing rules (Nth-ended vs duration*loops vs
      holdSeconds override; skip dwell min) with tests (171 tests,
      2026-10-31)
- [x] Renderer: loopCount looping via ended-counting, holdSeconds
      background play; verify steps for both paths (loop=true never
      fires ended - restart per pass, 2026-10-31)
- [x] Demo fixture: short looping video item (loopCount 2); determinism
      and validator green (verify step 27: 2 endeds + restart observed,
      30 steps 29 pass, 175 tests, 2026-10-31)
- [x] Converter image policy: true-format sniff, byte-identical preserve
      when browser-compatible, lossless-JXL-when-smaller (cjxl probed at
      runtime, djxl round-trip verified); ledger records each decision
      (landed with Phase 10, 2026-10-31)
- [x] Converter video policy: pass through browser-native sources;
      transcode only what no target browser plays (landed with Phase 10,
      native h264 copy proven on fixture, 2026-10-31)

## Phase 9c: Video playback ranges (2026-10-31, user requests)

- [x] Format/schema/validator/CREATE: optional `startSeconds`/
      `endSeconds` (exact fractional seconds, no rounding; defaults 0
      and durationSeconds); range validation; frame-number authoring
      convenience documented (seconds stored); converter poster-at-start
      note; shared-file-different-ranges documented (39 pytest tests,
      2026-10-31)
- [x] Machine: range-based timing (gate and skip clamp use
      endSeconds-startSeconds; ended emitted at range end) with tests
      (180 tests, 2026-10-31)
- [x] Renderer: seek to start on enter, range clamp, seek-back-to-start
      loop (never loop=true on ranges), chain continues without
      restart, poster = frame at start; pass boundaries via
      requestVideoFrameCallback (timeupdate only as fallback, being
      4-250ms coarse); verify tests the ACTUAL first/last displayed
      frames and RECORDS the observed tolerance (seconds/frames) in
      docs/verify-player.md - no frame-exact claims (Chrome measured
      0.000s; 183 tests, 31 verify steps, 2026-10-31)
- [x] Demo fixture: shared ~2 s clip used by two items at different
      ranges (0.0-1.0, 1.0-2.0) with range posters; determinism green
      (16 files byte-identical, 2026-10-31)

## Phase 9d: Loop restart point (2026-10-31, user request)

- [x] Format/schema/validator/CREATE: optional `loopStartSeconds`
      (fractional seconds; default = startSeconds; must be < effective
      end); first-pass vs loop-pass timing documented; poster stays at
      startSeconds (46 pytest tests, 2026-10-31)
- [x] Machine: gate = firstPass + (loops-1)*loopPass with
      loopStartSeconds; holdSeconds and text hold unchanged; tests
      (188 tests, 2026-10-31)
- [x] Renderer: fresh entry seeks to startSeconds; after the first pass
      completes, later passes restart at loopStartSeconds; verify step
      measures the loop-back landing near loopStart and records the
      observed tolerance (OBSERVED +0.020 s: first presented frame past
      1.5 s, which is not a 25fps frame time; 191 tests, 31 steps,
      2026-10-31)
- [x] Demo fixture: `part-013` gains `loopStartSeconds: 1.5` (range
      1.0-2.0, loopCount 2); determinism and validator green (16 files
      byte-identical, 2026-10-31)

## Phase 10: Ren'Py extractor MVP

- [x] `converter/` package with CLI over source `.rpy` projects (kinetic-
      extract; accepts project/game/.app; 11 tests, 2026-10-31)
- [x] Statement subset parser; unknown statements reported, not fatal
      (menu/unknown/layer reported, Cyrillic + `[var]` literal, 2026-10-31)
- [x] Asset pass per Phase 9b policy: preserve browser-native video,
      transcode only non-browser-playable to H.264; images preserved or
      converted by size; posters via ffmpeg (extractor ships `.jxl` for
      the demo's small PNGs because libjxl beat them on bytes - see the
      JXL-vs-broad-compat note below; 59 tests, 2026-10-31)
- [x] Content-sniffed formats (never extension); wrapped images carved
      when PNG/JPEG magic is in the first 64 B, else reported skipped
      (obfuscated/rpg-pickle images deferred to Phase 11's decoder)
- [x] Identical sources deduped into shared derivative files (ledger
      dedupOf; bg-room shared by two ids)
- [x] `build-ledger.json` written as an unreferenced extra; validator
      tolerance tested (exit 0 on output with ledger)
- [x] `fixtures/renpy_demo/` + golden-manifest pytest green (11 tests)
- [x] Extracted demo plays end to end in the player (head-to-tail walk:
      14 items, all visuals painted incl. .jxl + video poster, zero
      console errors, 2026-10-31)

## Phase 11: Extractor completeness on the real corpus

- [x] Several distinct kinds sampled from <corpus>
      (.app+.rpy, loose dir, .rpyc-only, .rpa-archive game, .zip; no
      .rpak found; Electron zip excluded; 30 converter tests incl.
      --label/--max-items/--files, 2026-10-31)
- [x] unrpyc vendored and pinned; `.rpyc`-only projects decompile
      (CensoredUsername v2.0.3 @ 3ae8334, 0 local mods; game-d 12 .rpyc
      decompiled, .rpy wins stale twins; 81 tests, 2026-10-31)
- [x] `.rpa` reader implemented (stdlib zlib+pickle; real format is
      RPA-3.0/2.0, not `!RP-A` - fixed the plan's assumption; XOR offsets
      + uncompressed members; game E archive scripts decompile + archive
      assets extract end-to-end; 92 tests, 2026-10-31)
- [x] Every sampled slice extracts and plays in the player (all five
      bugs fixed - implicit image/video registration, drop-unresolved +
      valid empty manifests + inert player empty state, Movie-def video
      items, no-space speakers, realpath symlinks; game A 6 videos painted,
      game B 4 images @1920, game E archive assets, game F clean, game C honestly
      empty cross-package; 106 pytest + 194 vitest, 2026-10-31)

## Phase 13: Author-defined branches (2026-10-31, user request)

- [x] Format/schema/validator/CREATE: item `id` fields + `branches`
      table (unique ids, references resolve, contiguous spans, route
      `result` default `ending`, exactly one `continuingRoute` per
      decision with `continueAt`) (69 pytest tests, CREATE example
      validates via real validator, 2026-10-31)
- [x] Machine: decision fire on settle-of-after, route spans, nested
      decision stack, route-end overlays (return/reselect semantics),
      play-all-routes, visited-set seen tracking + jumpToUnseen/skipAll
      route-aware targeting; tests incl. the three unseen-target cases
      (234 tests at landing; e-lands-on-first-unseen semantics noted,
      2026-10-31)
- [x] Storage: PersistedState `visited` + `position` (decision stack)
      with migration from frontier-only states; bookmarks carry route
      context; restore + migration tests (ctx on PersistedState +
      bookmark records; DB stays v1; 245 tests, 2026-10-31)
- [x] Renderer: decision overlay (prompt + numbered routes, click and
      1..9), route-end overlay (unseen routes + return-to-main or
      ending reselect), `Play all routes` toggle in `c`; verify steps
      (280 tests; driver/docs resynced to first-unseen semantics; 33
      steps green, 2026-11-01)
- [x] Demo fixture: shared lead-in, decision with continuing route +
      explicit-ending route (one nested mini-decision inside a route);
      determinism + validator green (41 verify steps 40+1 known partial:
      decision fire, nesting, return-row proven, play-all auto-order,
      resume ctx, e-into-unseen-route; deterministic rebuilds,
      2026-11-01)
- [x] Extractor: conservative `menu:` -> decision detection (contiguous
      runs, no guessed joins, ledger notes) with golden-style tests
      (pure-choice all-played -> region-end+1 fall-through rule found by
      the extracted walk and specced; game B spot: 33 menus honestly
      skipped for jump-exit; 283 + 139 tests, 2026-11-01)
- [x] docs/extracting.md has a per-game entry incl. what was skipped
      (6 games logged; 1 slice with real media (game F 4/4 painted), 4
      zero-media logged with root causes; 5 extractor bugs recorded for
      item 4; play-folder.mjs reusable, 2026-10-31)
- [x] New parser branches covered by pytest (test_implicit.py +13:
      registration precedence/spaces/ambiguity, Movie def, no-space
      speakers, symlink rels, drop-unresolved, empty output; 2026-10-31)

## Phase 12: Performance, packaging, docs

- [x] ImageBitmap preload with LRU cache in the renderer (data chose
      the variant: hidden-Image() LRU(8) of next 3 visuals -
      ImageBitmap would need a canvas presenter the numbers didn't
      justify; docs/perf.md, 288 tests, 2026-11-01)
- [x] Perf harness output recorded here; p95 navigation < 41 ms (npm
      run perf, headless Chrome file://: demo p95 36.7 -> 16.8 ms;
      extracted-with-JXL folder 32.2 -> 18.6 ms; target met, no
      revisit trigger, 2026-11-01)
- [x] Self-contained novel folder plays by double-clicking `index.html`
      over `file://` (npm run package-proof 18/18 on demo +
      extracted-with-JXL folders: paint, advance, help, zero errors;
      assemble_folder.py reproducible, 2026-11-01)
- [x] docs/packaging.md written; Tauri path noted, not built
      (folder contents, both assembly paths, zip-to-reader, revisit
      trigger, browser-matrix + no-audio caveats, 2026-11-01)
- [x] README accuracy pass; this file fully checked (fresh-eyes audit:
      8 drift fixes incl. e-landing, resume, first-load help, extractor
      scope; CREATE stale-planned section refreshed; all boxes below
      this line checked, 2026-11-01)

## Phase 13b: Manual/auto mode clarity + key help (2026-11-01, external-user report + user clarification)

- [x] Key help overlay: built from the keymap module (single source,
      test asserts coverage); first-load display with persisted
      `helpSeen`; Escape opens (machine paused, screen black), Escape
      closes and resumes the same item (hold re-arms); shares the
      suspend gate with h/t/c; fullscreen first-Esc caveat documented
      (2026-11-01)
- [x] Verify manual-by-default + `a` auto-forward toggle + live speed
      slider end-to-end (verify steps in BOTH modes: bookmarks,
      history, skip, skip-unseen); fix any real bug (33 verify steps,
      32 pass + known partial, 266 tests, no bugs found in both-mode
      behavior, 2026-11-01)

## Phase 14: External tester findings (2026-11-01)

- [x] Persistence durability: reading position must survive an
      immediate reload (the 250 ms debounced state write is lost;
      pagehide flush cannot commit an IDB transaction mid-flight -
      reproduced on HEAD 007b5aff: bookmark+immediate reload resumes at
      stale item, though the bookmark itself restores correctly). Fix:
      persist position immediately on change; bookmark capture flushes
      state; the "Bookmarked" confirmation appears only after the
      commit; verify step proving bookmark + immediate reload resumes
      AND restores; docs updated. (Fixed: immediate single-slot
      write-with-latest-pending replaces the debounce; flash awaits
      bookmark+state commits; 42-step verify + repro prove
      pill->reload 43 ms resume; 294 tests, 2026-11-01)

## Phase 15: Minimum video play time under chains (2026-11-01, external tester)

- [x] Format/schema/validator/CREATE: optional `minPlaySeconds` on
      video items (>0), chain-exit semantics + manual/skip-immediate
      documented; per-item not per-file; validator type/positivity +
      CREATE example note (73 pytest tests, 2026-11-01)
- [x] Machine: chain-exit floor max(hold, minPlay - chainElapsed) for
      the last item of a text chain over a video with the field,
      machine-time bookkeeping, auto/skip-dwell/play-all paths honored,
      manual advance unaffected; tests incl. the 8 s/5.829 s scenario
      (chainHeadAt anchored to timer-arm; 302 tests, zero adaptations,
      2026-11-01)
- [x] Demo fixture + verify: ~6 s clip + dialogue chain with
      minPlaySeconds 4.5; step proves the wait (~4.5 s, not ~2 s) and
      that skip stays immediate; determinism green (auto exit +4548 ms
      wall vs skip-through 516 ms; skip-exclusion resolved per the
      tester's ask - plan corrected; 44-step driver 43+1 known, 302
      tests, byte-identical rebuilds, 2026-11-01)

- [x] External re-report (2026-11-01): skip-all reportedly still waits
      for `minPlaySeconds` at chain exit on a video with BOTH
      `holdSeconds: 8` and `minPlaySeconds: 8` + 2 text + image
      (reproduced on 3c70ed1, which predates the 2bd3e42 skip
      exclusion). Reproduce at HEAD with that exact config + skipAll
      ON; fix if real; add the config as a permanent machine regression
      test either way. (VERDICT: stale report - the repro commit
      predated the skip-exclusion fix; at HEAD the exact config exits
      the chain at 360 ms under skip, auto still 8000 ms; regression
      tests added, 305 green, 2026-11-01)

## Phase 16: Player feedback from the playable demo (2026-11-01, user)

- [x] Styling pass (merges three style points): all overlay text and
      the choice prompt/rows center; thoughts render pastel-blue and
      KEEP the speaker name when named; demo verified + docs.
      Closes the Phase 7b deferred styling direction (first pass).
      (Named-thought speaker was never broken - demo thoughts simply
      had no speaker; new overlay test pins it; measured centering +
      computed colors; 306 tests, driver unchanged 43+1 known,
      2026-11-01)
- [x] Reading-speed config: minus button + draggable slider + plus
      button, current speed as smaller text to the right.
      (measured: minus < slider < plus x-order, readout 10px vs 13px
      labels; native range 0.25-3.0 step 0.25 matching the repo's
      multiplier model; live setSettings proof: 5523 ms hold at 1x vs
      3004 ms at 3x; survives reload; +6 tests, 312 green, 2026-11-01)
- [x] Single-action navigation: reproduce what needs more than one
      action, then one space = one step and one wheel tick = one step
      both directions, manual and as space-in-auto; auto's own
      hold-then-advance unchanged. (repro at HEAD: 2 presses/item +
      50px tick dead; fixed via manual-press settles-and-moves +
      wheelPlan >=8px notch rule; 500px=5 steps kept; 316 tests,
      scenario strict 1:1 presses->moves, 2026-11-01)
- [x] Phase-closer: rework verify.mjs press helpers for one-press
      advance (advancePair's 7 uses + the manual-freeze steps), then
      the full suite close-run (44-step driver, full pytest,
      package-proof) for Phase 16. (14 steps reworked to the new
      semantics; 3 new steps (one-press 1:1, decision-on-nav,
      reset-progress) -> 47 steps: 46 pass + 1 known partial, ZERO app
      regressions on first full run; close-run: 376 vitest, 154
      pytest, package-proof 18/18 on sharded folders; verify-player
      resynced; 2026-11-01)
- [x] Decisions surface on navigation (merges the wheel and tab
      points): arriving at a decision's after by wheel or tab-shows
      shows the overlay and waits; tab-skip pauses at decisions
      (the pick stays manual, no auto-resume); play-all remains the
      no-pause path.
      (arrival-open state is unconsumed + timer-proven paused; digit
      chooses like a fired decision; skip burst ENDS at the decision
      and the pick stays manual - plan reworded accordingly; 321
      tests, scenario real-Chrome, 2026-11-01)
- [x] Re-opening a decision after ANY completed route offers
      "Return to main route" whenever a continuing route exists;
      the ending-route loop gains an exit. (offersContinue single
      rule - fired/re-offer/arrival views alike; row last, Enter ->
      continueAt once, stack popped; 324 tests, real-Chrome scenario,
      content-format result bullet updated, 2026-11-01)
- [x] Route seen mark = route PLAYED (its items became current), not
      the decision firing; taking one route must not mark the other
      seen. (investigation: the rule already held - the user's
      profile had genuinely played "Turn them down" earlier, save is
      scoped per content; fresh profile proven [hire=true,
      refuse=false] at arrival + fired views; played = ENTERED by any
      means, rule + continue-offer wording aligned in
      content-format.md; +6 tests, 330 green, 2026-11-01)
- [x] Play-all-routes on the demo: reproduce the no-branches report,
      fix, and add route announcements (flash "Route: <label>" on
      route entry; "Back to try another route" on the jump-back).
      (root cause: arrivals never auto-resolved under play-all + no
      journey feedback; now auto-resolves on arrival for undecided
      decisions, resolved history untouched, `e` proven to reach
      missed routes; render/routes.ts announces entries + back-jumps,
      manual picks flash too; scenario shows the full refuse->back->
      hire->inner sequence with all six pills; 339 tests, 2026-11-01)
- [x] `e` at the end of content must land on the first unseen item
      including route content (repro: after reaching the final
      ending, `e` did nothing though routes were unseen). Plus the
      new rule: when ALL content is seen, `e` shows the ending - the
      most recently seen ending when branches gave several (track
      last-ending-touched in the resume ctx). (fresh-save repro
      jumps fine - user's save had seen everything, old rule no-oped;
      unseen-wins pinned anyway; endings = array end + ending-route
      finals, lastEnding in ctx w/ clean legacy migration; repeat e
      stays put; scenario 10/10; 344 tests, 2026-11-01)
- [x] Auto-forward stall at `part-012` after viewing to the end and
      wheeling back to start under auto: navigated re-entry into a
      range video must replay and gate honestly. (root cause: below
      the seen edge videos show a STILL and never report ended, yet
      the gate demanded pass reports; gate below edge = time bound
      alone (equals the replay), at edge unchanged replay+reports;
      user flow walks to end, max gap 4.1 s = a legitimately long
      text hold; 348 tests, 2026-11-01)
- [x] `playAllRoutes` persists across reload like the other settings.
      (root cause: idb sanitizeSettings whitelist omitted the field -
      stored but dropped on read; sanitizer now derives fields+types
      from DEFAULT_SETTINGS so no setting can be missed again;
      scenario: reload ON/OFF both correct; 351 tests, 2026-11-01)
- [x] Video re-watch does not replay: after passing videos, wheeling
      back before them, then advancing forward with space/auto, they
      show only their poster. A forward re-entry must play the video
      again like first arrival. Reproduce, root-cause against the
      Phase 16.9 `mediaGateSatisfied` change + the renderer play
      trigger, fix so any forward current-item set plays a video.
      (culprit: playbackModeFor forced poster for EVERY below-edge
      cursor; machine now tags each step advance|nav (one funnel,
      non-moving commands never rewrite it); advance plays at any
      cursor, nav-below-edge + skipping stay posters, at-edge
      unchanged; scenario: space + auto replay all three videos,
      wheel stays paused; 360 tests, 2026-11-01)
- [x] New "Reset progress" config option: clears ALL saved state for
      the content (resume, seen/visited, played routes, bookmarks,
      settings) to restore the first-ever-play experience incl. the
      first-load key-help; a confirmation box ("Are you sure?")
      guards it - nothing clears until confirmed, cancel is a no-op.
      Verify: state survives reload until confirmed; after confirm the
      app is fresh at item 1 with help shown. (#confirm overlay,
      Enter/y vs Esc/n, suspends like h/t/c; flush->delete->reload
      with the pagehide re-save guarded; deleteState/deleteBookmarks
      on the storage interface; scenario 16/16: cancel keeps state+
      bookmark, confirm boots fresh with help; 363 tests, 2026-11-01)

## Phase 17: Converter media organisation into subfolders (2026-11-01, user)

- [x] Confirm/format: a media item's `file` may carry a subfolder
      path (`assets/ab/<id>.jpg`); validator + schema accept a relative
      subpath, still forbid `..`/absolute; player resolves it from the
      folder root; the missing-file walk and package-proof follow
      subpaths. Fix any gap; test a subpath fixture. (schema tightened
      to segment grammar + flat-name-shape LAST segment (id stem <=64,
      one optional .fNNN/.poster/.thumb, ext whitelists unchanged);
      validator basename rule; player resolveMediaPath via
      new URL(path, contentRoot) + stays-inside-root assert at
      parse time; play-folder.mjs now path-keyed (was basename -
      phase-closer note); proof walk of a bucketed demo copy: painted
      + missingFiles [] + 0 console errors; 81 pytest + 376 vitest,
      validator 0 on all three fixtures, 2026-11-01)
- [x] Converter: shard extracted media into 2-char hash-prefix buckets
      (`assets/<2hex>/<id>.<ext>`), deterministic (hash of the name,
      not a counter); update the extractor + golden so every referenced
      file exists and shard placement is stable across runs; docs
      (content-format, extracting) updated. (media_ref wired into every
      writer - manifest/ledger/posters/frames share one ref string;
      --flat opt-out; golden regenerated (12 path lines, byte-identical
      to a fresh run); bucket-exists + two-run byte-identity + flat
      tests; validator green on sharded, flat and artifact; 73
      converter tests, 2026-11-01)

## Phase 18: Second demo-feedback round (2026-11-01, user)

- [x] `e` resume-first: with unseen content remaining, pressing `e`
      away from the last-shown item lands ON the last-shown item
      (resume); from there it keeps the first-unseen stepping; all-seen
      keeps the most-recent-ending rule. Tests + docs. (lastShown now
      tracks READING moves only - wheel scrubbing no longer moves it,
      which is what makes resume honest; exact user-flow test + below-
      edge poster interaction pinned; 378 tests, 2026-11-01)
- [x] "Return to main route" only after the CONTINUING route has
      completed at least once; "Enter returns" hint renders only when
      the row exists. content-format + CREATE reword; tests. (new
      completedRoutes set marked at route ends incl. the auto-join;
      ctx migration: legacy saves show no row until the continuing
      route finishes once; sanitizeContext caught dropping it; hint
      conditional, Enter-no-row silently inert; verify steps 33-34
      flagged for the phase closer; 384 tests, 2026-11-01)
- [x] Navigation arrival re-opens COMPLETED decisions (re-offer with
      seen marks; return row per the new rule) so every decision point
      surfaces when scrolling back, nested included. (frameless arrivals
      find nested decisions via ancestor route spans; closed pure
      choices re-offer on arrival; play-all passes completed arrivals
      through; 390 tests, 2026-11-01)
- [x] Wheel (any notch, any direction) closes the choice overlay -
      fired, arrival, or re-offer - and navigates; only keys choose.
      (closing a fired/re-offered view restores its route stack, so
      the reader is back inside the route and its end re-offers; 393
      tests, 2026-11-01)
- [x] Skip never reveals unseen: burst advances only through seen
      items and stops ON the last seen; tab from a fresh start moves
      nothing; skipAll unchanged. README/verify wording + tests.
      (a continuing route's end into an unseen join counts as a reveal;
      verify step 17 rewritten for the phase closer; 395 tests,
      2026-11-01)
- [x] Ending hint: when an ending shows and unseen content remains, a
      quiet standing line invites `e`; absent when all seen. (machine
      `endingHint` state, hidden under a choice and by `h`; #ending-hint
      at the top; 397 tests, 2026-11-01)
- [x] Play-all: black interstitial (~2.5 s machine-held) on each
      back-in-time jump showing prompt, last route, seen marks,
      highlighted new route; route pills 1.6 s. Scenario proof.
      (machine `interstitial` state + INTERSTITIAL_MS, a press ends it,
      pause freezes it; context line falls back to the nearest earlier
      text; the back pill is dropped after an interstitial; ending hint
      off during the hold and at play-all route endings. Scenario run on
      the real demo in the browser: refuse-020 -> interstitial "Offer
      them the job NOW PLAYING / Turn them down JUST FINISHED" held
      ~2.5 s -> hire-016 with the route pill. 405 tests, 2026-11-01)
- [x] The wheel walks seen items only (found in Claude's demo pass,
      2026-11-01: wheeling back from the main ending walked into the
      unplayed "Turn them down" route, showing its ending card and
      marking it seen; forward had the same flaw). Unplayed route spans
      are stepped over both ways; the main.ts input gate also let the
      wheel through a FIRED choice now (item 4's machine rule was
      unreachable in the real player). (405 tests, 2026-11-01)
- [x] `e` never acts as a forward step (user, 2026-11-01; reproduced on
      the demo: from a fresh start each `e` press advanced one item,
      revealing new content like Space): standing at the reading
      position with the next unseen item simply next in reading order,
      `e` does nothing. It still resumes to the last-read item, jumps to
      unseen content elsewhere (an unplayed route) and shows the ending
      when all is seen. Help/README wording agree; tests. (rule: at
      the reading position a target of `cursor + 1` is a no-op - also
      keeps `e` from entering a route's items at an unanswered
      decision; 8 tests that pinned "repeated presses step unseen"
      rewritten; 405 tests, 2026-11-01)
- [x] Demo rebuild (user, 2026-11-01: "re-create a good demo and tests
      for it" instead of patching): a fresh `fixtures/build_demo.py`
      with one labelled section per feature and EVERY line of text
      explanatory (no story), covering every content feature in README
      (speech/thought/narration, bare image, animation, video chain,
      loopCount, holdSeconds WebM, ranges + loopStart, minPlaySeconds,
      branches: continuing route with a nested continuing/return pair,
      an ending route, shared aftermath). Deterministic build; README
      lists the sections; validator tests look items up by id.
      (sections: intro, text kinds, animation, video chain + still chain, loopCount MP4 + holdSeconds WebM, ranges, floor, branches; lines kept short where reading time must not mask loopCount/holdSeconds; deterministic; 82 validator tests, 2026-11-01)
- [x] Scenario suite replaces `player/scripts/verify.mjs`: a shared
      harness plus independent scenario scripts, each on a fresh
      profile (no state inherited between scenarios), one runner
      (`npm run verify`). Every old driver step 1-47 maps to a scenario
      (mapping table in docs/verify-player.md); the old driver is
      deleted; AGENTS.md test-speed rules updated.
      (6 scenarios / 127 checks green: reading, media, navigation, screens, branches, playall; old steps mapped in docs/verify-player.md. Found and fixed on the way: bookmark click after a wheel-back landed on the reading position; play-all + skip-all burst stopped at each interstitial. 2026-11-01)
- [x] Key help simplified (user, 2026-11-01): the Esc screen highlights
      the main interaction keys only, one way per action. Enter is
      removed as an alternate key everywhere (never requested): `0`
      picks "Return to main route" (the row shows 0), help closes by
      Esc/Space/click; the reset box's keys are not listed in the help.
      Tests, README, scenarios updated.
      (Enter removed everywhere; `0` picks the return row, badge "0", hint only with the row; help rows Space, wheel, E, Tab, A, H, B, T, C, Esc, 1-9 / 0; reset keys unlisted; scenarios press 0 and prove Enter inert. 427 tests, 2026-11-01)
- [x] Delete a bookmark (user, 2026-11-01): each thumbnail in the `t`
      list shows an "x" in its top-right corner; clicking it removes that
      bookmark (storage included) without opening it. README feature
      line; tests + scenario.
      (× in each thumbnail corner; storage deleteBookmark in idb + memory; list re-renders keeping scroll; screens scenario: delete one of two, survives reload. 2026-11-01)
- [x] README tidy (user, 2026-11-01): cut wordiness and duplication
      (e.g. the `a` line repeats the manual Space mode that belongs on
      the Space line); one concise line per feature. State what IS,
      not hedged plans (e.g. "if we use a browser" -> it is a browser
      player); same reality pass over the other user-facing docs.
      (README rewritten: Playing / Content / Tools / The demo / Not
      supported, one line per feature, ~1056 -> ~670 words; CREATE.md
      drops its stale copy of the controls and "later phases" hedge.
      2026-11-01)
- [x] Settings survive an immediate reload (found by the screens
      scenario, 2026-11-01: four `+` clicks then a reload within ~100 ms
      came back at 1.00x in 4 of 6 runs; fire-and-forget settings write).
      Same durability as `b`'s commit-then-confirm.
      (cause: a settings write queued behind a running write; urgent writes now go immediately and replace any queued older value; idb commit() on save; screens scenario: 3 rounds of clicks + immediate reload, 18/18 green and red on the old path. 2026-11-01)
- [x] History rollback (user, 2026-11-01: "scrolling back should show
      what was originally seen going forward"; choice screens are the
      key visual waypoints of a fast roll back). The machine records
      every screen shown while reading - each item with its route
      context, and each choice screen (first fire and route-end
      re-offers) as its own entry - and the wheel replays that record
      exactly, back and forth, choice screens included (shown in full).
      Space from a rolled-back point reads on: while it matches the
      record it just moves along it; a different path (another pick at
      a rolled-back choice) replaces the recorded future, as in Ren'Py
      rollback. `e` and bookmark jumps append to the record. The record
      (capped) persists in the save, so roll back works after a reload.
      Absorbs the "route context recomputed on navigation" proposal: a
      rolled-back entry restores its own route frames. Machine tests,
      docs, scenarios (navigation, branches) updated.
      (machine history of item + choice-screen entries with their route
      frames, pos, replay/fork, cap 5000, persisted in ctx with legacy
      migration; `e` = jumpToEnd; arrival views and the seen-only wheel
      removed; route pills quiet on replays. 416 tests; scenarios 138/138
      incl. "Route 2 then Route 1, scroll back shows Route 1, re-offer
      screen, Route 2, first choice screen, decision picture". 2026-11-01)
- [x] End card (user-approved proposal): an ending shows how many routes
      are still unseen and the one-key way to the next one, replacing
      the one-line hint.
      (#end-card replaces the one-line hint: 'N routes [and other content] still unseen.' + 'Press u for the next one.' when u has a target; 'You have seen everything.' in branching manifests once all is seen; not at play-all route endings or the interstitial; h hides it. branches scenario checks route2-end, after-end, all-seen. 465 tests, 2026-11-02)
- [x] Fast smoke subset of the scenario suite (user-approved proposal):
      `npm run verify -- --smoke` runs one quick check per scenario
      (~20 s); AGENTS.md per-item rule points at it.
      (smoke.scenario.mjs, 6 checks in ~4 s; `--smoke` flag in run.mjs;
      AGENTS.md + docs/verify-player.md updated, 2026-11-01)
- [x] Faster Tab skip (user, 2026-11-01: "too slow... something more
      like Ren'Py"): Ren'Py's `config.skip_delay` defaults to 5 ms per
      statement, so its skip runs at display frame rate (~30-60 lines/s);
      ours dwells 120 ms (~8/s). Default `skipDwellMs` ~25 ms (~40/s),
      still showing each item's first frame; check media decode keeps up
      (docs/perf.md budget) and update the skip timing bounds in tests
      and the navigation/media scenarios.
      (skipDwellMs 120 -> 25 ms; a stored dwell is ignored so saved profiles get the new pace; clamp tests pinned to an explicit 120 ms; navigation/media scenarios judge the burst by total time; green twice in a row. 2026-11-01)
- [x] Skip-all + play-all keeps skipping across route changes (external
      conversion agent, 2026-11-01, on a025c94: after the "Back in time"
      screen the skip stopped on the next route's first item until Tab
      was pressed again). Fixed in f5629d6: an interstitial that ELAPSES
      resumes the skip burst (a press during it still means stop); unit
      test in branches.test.ts, and the playall scenario requires the
      whole burst on ONE Tab press (green).
- [x] Saves keyed by id, not position (user, 2026-11-01: content updates
      such as a prequel must keep saves valid). The seen set, position,
      history, bookmarks and played/completed routes store item /
      decision / route ids, so inserting, reordering or extending content
      never re-points saved state. No migration: there are no released
      games to stay compatible with (user), so old index-based saves are
      simply dropped. Tests: a save made against one manifest restores
      correctly against a manifest with items inserted before it.
      (storage/ids.ts codec converts at the storage boundary: item/decision/route ids for seen set, position, stack, played/completed, history; unknown ids dropped individually; old index saves resume as first boot; bookmarks store itemId. Also fixed: a bookmark restore REPLACED the seen set - now unions seen/played/completed. ids.test.ts: prequel + mid-route insert + deletion; screens scenario swaps in a prequel manifest. 447 tests, 2026-11-01)
- [x] Reach unseen content from anywhere (user, 2026-11-01): a key (e.g.
      `u`) goes to the next unseen content wherever it is, earlier
      content included (a prequel, a new mid-story route); a quiet
      notice on resume when unseen content exists before the reader's
      position. `e` stays "go to the end". Folds into the end card item
      (the end card offers the same jump). Help, README, scenarios.
      (u: first unseen item after the cursor in array order, wrapping to earlier content; never what Space reads next, never routes behind an unreached decision; an unplayed route is entered as if picked (frames open, marked played); appends to history. Resume notice 'Earlier content you haven't seen - press u.' when content was passed over before the position (a prequel), not for declined routes. screens content-update scenario: notice + u lands on the prequel. 2026-11-02)
- [x] Skip can play videos (user, 2026-11-01): a config option ("Skip
      plays videos", default off) makes a skip burst play each video as
      it would play when not skipping (its loops / duration) before
      moving on; Space during such a playback aborts that video and the
      burst continues. Off keeps today's first-frame skip. Settings
      screen, README, tests, scenario.
      (setting 'Skip plays videos', default off: a skip burst waits each video's own time bound and plays it; chain lines after it dwell with the video playing under them; Space aborts the video and the burst continues. media scenario: floor clip ~6.0 s, then stops on branch-title; Space abort < 800 ms. 2026-11-01)
- [x] Space during auto-forward returns to manual (user, 2026-11-01):
      with auto-forward on, Space turns it off and the reader continues
      manually from the current item (that press does not also step;
      the next Space does). Replaces "in auto-forward Space ends this
      item first". Help, README, tests, scenario.
      (Space with auto on turns it off, no move; next Space steps. Space that stops a skip also turns auto off, so the next press steps. reading scenario check. 2026-11-01)
- [x] Skip paces by pictures (user, 2026-11-01): during a skip burst a
      `text` item takes zero time and the overlay text is hidden, so the
      constant ~25 ms pace applies to pictures and video stills only.
      Every text item is still walked: marked seen, recorded in the
      history, and subject to every stop rule (never reveal unseen, a
      decision hanging off a line, route ends), so skip can still stop
      ON a particular line, which then shows normally once skip ends.
      Tests (a 5-line chain costs one picture's dwell), scenario.
      (text items take zero time in skip, walked in a loop (runSkip) so each is still shown, marked seen, recorded and stop-checked; captions hidden while skipping, shown on the stop line; with Skip plays videos the chain lines also take zero time. Unit: a 5-line chain costs one dwell. navigation/media scenarios. 2026-11-02)
- [x] Menus pause the timeline (user, 2026-11-01): opening the config
      (`c`) or bookmark (`t`) screen pauses a running auto-forward or
      skip burst (no item advances behind it, a playing video pauses as
      under the Esc help), and closing the screen resumes exactly what
      was running (auto-forward with a fresh hold, or the skip burst).
      A bookmark click that jumps away does not resume the old burst.
      Tests, scenario.
      (c, t and the reset box pause the machine (skip kept, nothing armed) and hold a playing video in place; closing resumes with a fresh hold or dwell; a bookmark jump ends the burst. menus.scenario.mjs, 4 checks. Full suite 166 pass + 2 headless-fullscreen partials. 2026-11-02)
- [x] Phase-closer: full suite (driver, vitest, pytest, package-proof),
      rebuild BOTH demo folders, present the updated demo to the user.
      (2026-11-02: vitest 465, biome+tsc clean, pytest 155, scenario suite
      8 files / 168 checks: 166 pass + 2 PARTIAL (headless Chrome does not
      enter fullscreen, so the first-Escape-leaves-fullscreen checks cannot
      fully pass headless), package-proof 18/18; .tmp/pkg-demo and
      .tmp/pkg-extract rebuilt; demo hand-checked in the browser: help,
      branch walk, return-row rule, end card + u, history roll back with
      choice screens, bookmarks with x, settings.)

## Phase 19: Third demo-feedback round (2026-11-02, user)

- [x] Nested pure choice ending its enclosing route (external agent
      report, 2026-11-02): when a nested pure choice's region runs to the
      end of its enclosing route, closing it ends that route (re-offer,
      join or close), never falling into the parent's next route.
      (11031db: closeIfPureAndComplete hands off to handleRouteEnd; two
      branches tests red before, green after; branches scenario 39/39.
      2026-11-02)
- [x] Play all routes shows the choice (user, 2026-11-02): with play-all
      on, every decision (first fire and each re-offer) shows the real
      #choice with a status line and draining bar counting down for the
      screen's reading time at the reader's speed (never under 2.5 s);
      then the picked row is highlighted ~0.7 s and the route starts.
      Routes go shortest first (fewest items), the continuing route last.
      A re-offer leads with "Back in time: <route> done." (replaces the
      black back-in-time interstitial, user option 3). Space takes the
      pick at once; a digit or click picks another route. Inside a
      skip-all burst there is no countdown, only the highlight, and the
      burst carries on. Choice screens are recorded in the history like a
      reader's; a replayed one waits. Turning play-all on over a live
      choice starts its countdown; off cancels it. Unit tests, playall
      scenario, README/docs.
      (6075ab3: machine autoPick on the open choice, countdown max(2.5 s,
      reading time of prompt + labels + ended route), 0.7 s highlight;
      reload onto a live choice re-arms it (subagent review fix);
      interstitial removed. vitest 475, playall scenario 19/19, branches
      39/39. 2026-11-02)
- [x] `c` works everywhere (user, 2026-11-02): the settings screen opens
      over a choice (the choice waits underneath, digits inert, a
      play-all countdown frozen and restarted on close) and over the Esc
      help (replacing it). Only the reset box blocks it. Tests, scenario,
      README/help text.
      (087163b: toggleConfig gated only by the reset box, closes help first;
      digits inert under a panel; #config z 6 over #choice. playall
      scenario 3 new checks, screens check rewritten (t still inert behind
      help). vitest 475, playall+screens 59 pass + 2 headless-fullscreen
      partials, smoke 6/6. 2026-11-02)
- [x] Settings screen clarity (user, 2026-11-02): the two skip settings
      read as options of how Tab skips, not switches that start skipping:
      a "When Tab skips" heading over "Skip unseen content too" and "Play
      videos in full"; Play all routes gets a one-line note. Tests,
      scenario, README.
      (25b6ced: heading + indented options, controls in one column (measured
      1280x720 and 700x900, screenshot checked); config.test layout tests;
      screens scenario check. vitest 477, screens 41 pass + 2 headless
      fullscreen partials, media 22/22, playall 19/19. 2026-11-02)
- [x] Phase-closer: full suite (scenarios, vitest, pytest,
      package-proof), rebuild both demo folders.
      (2026-11-02: vitest 477, biome+tsc clean, scenario suite 8 files /
      169 checks: 167 pass + 2 PARTIAL (headless fullscreen), pytest 155,
      package-proof 18/18; .tmp/pkg-demo and .tmp/pkg-extract rebuilt.)

## Phase 20: Fourth demo-feedback round (2026-11-02, user)

- [x] `a` counts time already shown (user option a, 2026-11-02): `a`
      looked dead on the demo's opening screen because turning auto on
      restarts the screen's whole wait (10.4 s there). Turning auto on now
      waits only for what is left of the screen's reading time, measured
      from when the screen first appeared (time under help or settings
      counts as shown). Machine test red before, green after; playall
      scenario check (`a` on intro-title moves on promptly after the
      screen has been up past its wait).
      (itemShownAt stamped in beginItem; setAutoAdvance(true) arms
      armTimer(itemShownAt) for the remaining hold; off/on also counts
      time shown. 5 new machine tests red before, green after; reading
      scenario check (intro-title moves within 1.5 s) red on old code.
      vitest 481, reading 13/13, playall 19/19, smoke 6/6. 2026-11-02)
- [x] Play-all choice: highlight and reading time (user, 2026-11-02): the
      route play-all will pick is highlighted from the start of the
      countdown, not only in the final ~0.7 s. Check that the countdown
      really counts every word on the screen (prompt, every label,
      "Back in time" line) and give choice screens extra comprehension
      time on top of plain reading time. Tests, playall scenario, docs.
      (choicetext.ts: one home for the screen strings; countdown =
      max(2.5 s, (chars of prompt + status line + labels + seen markers +
      return row) x ms/char + 1.5 s + 1 s per row) / speed. Demo at 1.00x:
      outer 4.5 -> 9.7 s, re-offer 5.6 -> 12.4 s, nested 5.5 -> 10.7 s,
      re-offer 7.4 -> 14.1 s. `.choice-next` marks the pick row from the
      countdown's first frame (screenshot checked). Tests red before.
      vitest 487, playall 21/21, branches 39/39, smoke 6/6. 2026-11-02)
- [x] Auto-forward on/off pill (user, 2026-11-02): "Auto-forward on" when
      it starts, "Auto-forward off" whenever it stops by any route in the
      code, using the route-entry pill mechanism. Tests, scenario, README.
      (machine setAutoFlag is the only writer, onAutoAdvanceChange fires on
      real flips; render/autoforward.ts flashes via the route pill. Only
      `a` and Space (in auto, or ending a skip burst) ever turn auto off;
      Tab, choices, the end and panels leave it on, so no pill. 13 new
      tests red before; reading scenario 4 pill checks (red with mount
      disabled). vitest 501, reading 17/17, playall 21/21, branches
      39/39, navigation 19/19, screens 41 + 2 headless-fullscreen
      partials, smoke 6/6. 2026-11-02)
- [x] Phase-closer: full suite (scenarios, vitest, pytest,
      package-proof), rebuild both demo folders.
      (2026-11-02: vitest 501, biome+tsc clean, scenario suite 8 files /
      175 checks: 173 pass + 2 PARTIAL (headless fullscreen), pytest 155,
      package-proof 18/18; .tmp/pkg-demo and .tmp/pkg-extract rebuilt.)

## Phase 21: Progress that survives moving the game (2026-11-02, user)

- [x] Story ID (user option a, 2026-11-02): manifest `storyId` from the
      converter (Ren'Py save_directory / name / folder), demo assembler
      and fixtures; validator and docs/content-format.md; player keys
      state and bookmarks by it (folder URL fallback), carrying over
      progress saved under the folder URL. pytest on touched files,
      vitest, scenario (move/rename the folder: progress kept).
      (storyId from save_directory, else config.name, else folder,
      slugged; e.g. game F -> the-lantern-at-low-tide, demo
      kinetic-demo. Player key story:<id>, folder-URL record moved over
      once (with bookmarks) then deleted so Reset stays reset. schema
      gains optional storyId, schemaVersion unchanged. pytest touched
      130, vitest 508, storyid scenario 4/4 (2 red on old player),
      screens+menus green, smoke 6/6. 2026-11-02)
- [x] Game name on the Esc screen (user, 2026-11-02): manifest `title`,
      shown at the top of the Esc help screen (and as the page title).
      Default from the Ren'Py project (`config.name`, else the project
      folder name); the game maker sets it with a converter option
      (`--title`) or by editing the manifest; the same option family
      lets them set `--story-id`. Fallback when absent: no heading.
      Tests, scenario, README, docs/content-format.md.
      (--title / config.name / folder name; --story-id override with
      slug check. Esc help h1 + document.title; untitled keeps "Kinetic"
      and no heading. game F -> "The Lantern at Low Tide", demo
      "Kinetic demo". pytest touched 165, vitest 513 (4 red before),
      screens 43 + 2 headless-fullscreen partials (heading check red on
      old player), smoke 6/6; screenshot checked. 2026-11-02)
- [x] Export / import progress (user option b, 2026-11-02): `c` screen
      buttons; export downloads `<storyId>-progress.json`; import checks
      the story, confirms, replaces this browser's state, reloads; then
      saving stays automatic. Tests, scenario, README.
      (storage/transfer.ts payload {kind kinetic-progress, version 1,
      storyId, title, state, bookmarks}; refusals in the panel's message
      line (not JSON, wrong kind/version, damaged, other story); confirm
      then one-transaction replaceProgress and reload. Thumbnails only
      data:image URLs. vitest 537 (red before), progress scenario 6/6
      (real download + file chooser; red on old build), screens 43 + 2
      headless-fullscreen partials, storyid 4/4, smoke 6/6; screenshots
      checked. 2026-11-02)
- [x] Phase-closer: full suite (scenarios, vitest, pytest,
      package-proof), rebuild both demo folders.
      (2026-11-02: vitest 537, biome+tsc clean, scenario suite 10 files /
      187 checks: 185 pass + 2 PARTIAL (headless fullscreen), pytest 216,
      package-proof 18/18; .tmp/pkg-demo (storyId kinetic-demo, title
      "Kinetic demo") and .tmp/pkg-extract rebuilt.)

## Phase 22: Progress note on the settings screen (2026-11-02, user)

- [x] Progress note (user, 2026-11-02): a minimal-word note in the `c`
      screen's Progress group: progress saves in this browser
      automatically; Export / Import only to change browser. Tests,
      scenario check, screenshot.
      (PROGRESS_NOTE "saved in this browser automatically ·
      export/import only to switch browser" under the PROGRESS heading,
      one line at 1280x720 and 700x900 (screenshots checked). vitest 538
      (2 red before), screens 44 + 2 headless-fullscreen partials,
      progress 6/6, smoke 6/6. 2026-11-02)
- [x] Play all routes note (user, 2026-11-02): "choices pick themselves
      after a countdown" reads as what the setting does now, wrong when
      Off. Reword so it explains what turning it On does, e.g. "On:
      choices pick themselves after a countdown". Tests, scenario check.
      ("when on, choices pick themselves after a countdown"; literal
      text test red before; config.test 28/28, vitest 538, screens 44 +
      2 headless-fullscreen partials, smoke 6/6; screenshot checked.
      2026-11-02)
- [x] Back-in-time line quotes the route (user, 2026-11-02): "Back in
      time: Route 2: an ending done." blurs the route's label into the
      message; quote the label (e.g. Back in time: "Route 2: an ending"
      is done.) so "done" clearly belongs to the message. Countdown text
      follows. Tests, playall scenario.
      (Back in time: “<route>” is done. … / Play all routes picked
      “<route>”; choicetext.ts; 3 tests red before; vitest 538, playall
      21/21, branches 39/39, smoke 6/6; screenshot checked. 2026-11-02)
- [x] Rolling back restores the routes (user, 2026-11-02): after play-all
      finished every route, rolling back to before the first decision and
      going forward again skipped the choices and all branch content (the
      Phase 13 all-played rule closes a decision once every route has
      played, and the played record was not rewound). Moving the reading
      position back to before a decision (wheel, e, goTo, bookmark) now
      restores the route-play state as of that point, like Ren'Py
      rollback, so the repeat run is identical to the first: choices
      shown, every route played again (play-all: shortest first). In-story
      re-arrival (hub loops) keeps the all-played rule. Seen markers stay.
      Reproduce first; tests red before; branches + playall scenarios.
      (User chose option 2, split: seen routes stay cumulative (marks,
      return row, end card, u, Phase 18 unchanged); new passPlayed
      record rewinds with wheel/e/resume/bookmark and drives only the
      flow (play-all pick, re-offer vs close, all-played close). Stored
      per history entry as delta passRoutes; old saves read played.
      10 new machine tests red before; playall user-steps checks red on
      old build. vitest 550, playall 25/25, branches 41/41, navigation
      19/19, screens 44 + 2 headless-fullscreen partials, smoke 6/6.
      2026-11-02)
- [x] Docs audit (user, 2026-11-02): every doc a reader, game maker or
      agent uses reflects Phases 20-22 (title, storyId and the converter
      options, export/import, auto-forward pill and timing, play-all
      countdown and highlight, rollback pass rule), e.g.
      docs/extracting.md has no --title / --story-id yet.
      (README c line, persistence, play-all; stack.md persistence
      keying; CREATE.md manifest; extracting.md "Story ID and title";
      verify-player.md Phase 22 checks. vitest 550, pytest 216.
      2026-11-02)
- [x] Phase-closer: full suite (scenarios, vitest, pytest,
      package-proof), rebuild both demo folders.
      (2026-11-02, after the last code commit; docs-only since: vitest
      550, biome+tsc clean, scenario suite 10 files / 194 checks: 192
      pass + 2 PARTIAL (headless fullscreen), pytest 216, package-proof
      18/18; .tmp/pkg-demo and .tmp/pkg-extract rebuilt.)

## Phase 23: Upgrade guide (2026-11-02, user)

- [x] Upgrading a game to a newer Kinetic (user, 2026-11-02): document
      how an existing Kinetic game folder takes a newer player for bug
      fixes (pull, build, replace only the player files, keep content
      and manifest, validate, when to re-extract or regenerate
      manifest.js, what happens to readers' saved progress). No notes
      about transferring saves from before Phase 21. Prove the steps on
      a copy of a demo folder.
      (CREATE.md "Upgrading to a newer Kinetic" + README Tools pointer.
      Only index.html + app.js are the player (dist/manifest.js is a
      placeholder that would clobber the game's). Proved on a copy of
      pkg-demo with a Phase-22 player: validator clean, no console
      errors, progress and bookmark survived the swap. vitest 550,
      pytest tools 109. 2026-11-02)

## Phase 24: Play-all pick without a text flash (2026-11-02, user)

- [x] No text change at the pick (user, 2026-11-02): in play-all, a text
      change flashes just as the route is picked and the branch starts.
      Identify exactly what changes (likely the status line switching to
      "Play all routes picked “…”" for the ~0.7 s picked phase, or a
      seconds/hint change) and make nothing but the row highlight change
      in that moment. Tests, playall scenario (text frozen across the
      picked phase), docs.
      (Cause: picked-form status "Play all routes picked “…”" and the
      hint dropping " · Space picks now" at the pick. Now text frozen at
      "picks in 1 s" (never 0) through the 0.7 s; only .choice-next ->
      .choice-picked. Probe confirmed. choice test + 2 playall checks red
      before; vitest 551, playall 27/27, branches 41/41, smoke 6/6.
      2026-11-02)
- [x] Play all routes on by default (user, 2026-11-02): Kinetic is an
      interaction-free kinetic game, so `playAllRoutes` defaults to on.
      A reader who saved Off keeps Off; Reset progress restores On.
      Tests and scenarios that need manual choices set Off explicitly.
      README / docs / CREATE.md wording.
      (DEFAULT_SETTINGS.playAllRoutes true. Stored settings are the full
      merged set, so a browser with saved progress keeps whatever it saved
      (Off for earlier readers); fresh profile, Reset or import without
      the field gives On. Harness setPlayAll / manualChoices for branches;
      branches.test manual baseline. config test red before; full
      scenario suite 196: 194 pass + 2 headless-fullscreen partials;
      vitest 551. 2026-11-02)
- [x] Reading speed named for auto-forward (user, 2026-11-02): the `c`
      screen's "Reading speed" becomes "Auto-forward speed" (or similar),
      with a short note that it also paces play-all's choice countdown.
      Help text, README, docs; tests and scenarios that read the label.
      ("Auto-forward speed" + note "also times play-all's choice
      countdown" on its own line under the row; stored key readingSpeed
      unchanged. config.test 3 red before; vitest 552, screens 45 + 2
      headless-fullscreen partials, reading 17/17, smoke 6/6; screenshot
      checked. 2026-11-02)
- [x] Clicks don't close settings or help (user, 2026-11-02): a mouse
      click (backdrop or anywhere) no longer closes the `c` screen or the
      Esc help; their keys still do (c / Esc; Esc / Space for help).
      Clicks on their controls still work. Hint lines updated (e.g. help
      "Esc or Space closes"). The `t` bookmark list is unchanged.
      Separators (user, 2026-11-02, dislikes "·" as "or"): in every hint,
      alternatives read "or" in words ("Esc or n cancels", "1-9 or click
      picks a route") and separate clauses use "; " instead of " · "
      (help, confirm, bookmarks, config, choice hints, progress note).
      Also: the speed readout "1.00x — ~60 ms/char" wraps at 700x900;
      keep it on one line.
      (help click listener removed; config backdrop click inert; first
      click still enters fullscreen, help stays, Space closes. All "·"
      gone from hints ("; " between clauses, "or" for alternatives,
      incl. "Esc or n cancels", "pick a route or return"). Readout
      nowrap + slider shrinks. 9 unit + 7 screens checks red before;
      vitest 555, screens 49 + 2 headless-fullscreen partials, playall
      27/27, branches 41/41, menus 8/8, reading 17/17, smoke 6/6;
      screenshots checked. 2026-11-02)
      Tests, screens scenario, README.
- [x] Phase-closer: full suite (scenarios, vitest, pytest,
      package-proof), rebuild both demo folders.
      (2026-11-02: vitest 555, biome+tsc clean, scenario suite 10 files /
      201 checks: 199 pass + 2 PARTIAL (headless fullscreen), pytest 216,
      package-proof 18/18; .tmp/pkg-demo and .tmp/pkg-extract rebuilt.)

## Phase 25: Reproducible, content-addressed media (2026-11-02, user + converting agent)

- [x] 25.1 Pinned media tools: Pillow + imagecodecs pinned in
      requirements.txt; tools/setup_media_tools.py fetches a pinned
      static ffmpeg per OS/arch with checksum into a local tools dir; the
      converter uses only these; single-threaded bitexact settings;
      golden-hash self-test at setup and converter start, refusing on a
      mismatch. Docs (AGENTS.md commands, converter README, CREATE.md).
      (Code done 2026-11-02: media_tools.py + selftest.py, pin file
      converter/media-tools.json (ffmpeg 9.0.2 martin-riedl static builds,
      Pillow 13.0.0, imagecodecs 2026.10.10 / libjxl 0.12.0), install dir
      .media-tools/<platform>/, cjxl/djxl replaced by imagecodecs, 14
      self-test cases, kinetic-extract refuses until pinned. pytest
      converter+tools 250. OPEN: user runs `.venv/bin/python
      tools/setup_media_tools.py --pin` to record archive sha256s and
      goldens; tick after that run passes.)
      (Pinned 2026-11-02 by the user on macos-arm64: archive sha256s and
      14 goldens recorded. Verified: setup without --pin passes the
      self-test; kinetic-extract on renpy_demo twice gives identical
      folders; validator clean. Other platforms pin on first setup.)
- [x] 25.2 Content-addressed layout: fixed folder `media/` (was
      `assets/`; user, 2026-11-02), `media/<h[:2]>/<h>.<ext>` by sha256
      of shipped bytes, posters too; remove name buckets, `--flat`, id
      pre-fill; streamed hashing. Docs replace Phase 17 wording.
      (media.py content_ref/sha256_file; assets.py _Placed writes each
      output once at media/<h[:2]>/<h>.<ext>; --flat and id pre-fill
      gone; a media item with a missing source is now dropped (skipped,
      noted). Golden regenerated (its poster hash follows the system
      ffmpeg until tests use the pinned one). 9 tests red before;
      pytest converter+tools 253, vitest 555, smoke 6/6; renpy_demo
      converted, validated and played. 2026-11-02)
- [x] 25.3 Source identity and ledger `media` section: loose path or
      archive + member, source sha256/size, steps with parameters, tool
      versions, output sha256; sorted, byte-stable.
      (ledger `mediaTools` + `media` keyed by output path: source {path}
      or {archive, member} + raw sha256/bytes, ordered steps (carve,
      preserve, convert, jxl, transcode, poster) with full params and
      ffmpeg args ({input}/{output} placeholders), tools per entry,
      alsoFrom for extra sources; items reference file/poster. 10 tests
      red before; pytest converter+tools 263. With the pinned tools:
      renpy_demo twice identical, mediaTools.pinned true, ffmpeg 9.0.2,
      validator clean. 2026-11-02)
- [x] 25.4 Decoder hook `--decoder MODULE:FUNC` per the Phase 25 spec
      (loose files and archive members, full bytes, None = unchanged,
      raise = loud failure; ledger hashes + hook identity + code hash).
      Test hook uses the converting agent's EXTRA formula on a synthetic
      file, purely as a hook test: it is NOT a correct decoder for the
      game (episodes 4-5 use an activation-dependent offset); the real
      hook lives in the game I package. 25.12's worked example
      must say so too.
      (decoders.py; hooks chain in order, None/identical = unchanged; a
      raise or non-bytes return stops the run (exit 1) naming hook and
      source; bad spec = usage error. Ledger: leading `decode` step with
      hook, hookSha256, input/output sha256; top-level `decoders`.
      Duration and display size measured on decoded bytes; a carve now
      counts only if Pillow decodes it. 12 tests red before; pytest
      converter+tools 280; real run with pinned tools shipped the
      wrapped PNG and a malformed one failed loudly. 2026-11-02)
- [x] 25.5 Image policy: lossless JXL via imagecodecs when smaller;
      WebP decode-encode with pixel check; JPEG recompression with exact
      byte reconstruction; animation kept; `.jxl` sources ship. Measure
      savings on a sample (incl. WebP-heavy) and record them.
      (JPEG: recompression, accepted only if the original bytes are
      reconstructed exactly. PNG/GIF/WebP: 8-bit pixels -> lossless JXL,
      pixel-identical round trip. Smaller-only. Animated kept (no frame
      durations in the encoder); 16-bit and odd modes kept; sRGB ICC
      dropped when pixel-neutral; .jxl sources ship; JXL magic fixed.
      Sample of 417 corpus images: JPEG -23.2%, PNG -46.2%, lossy WebP
      0% (all 202 bigger as exact JXL, 2.0-6.7x), total -23.0%. New
      self-test case pinned (15 goldens); setup gains --repin CASE.
      46 failing before; pytest converter+tools 314; pinned renpy_demo
      twice identical, validator clean. 2026-11-02)
- [x] 25.5b Lossy WebP skips the JPEG XL attempt (user option a,
      2026-11-02): an exact JXL of a lossy WebP was larger in all 206
      measured files and costs ~27 s each; lossy WebP ships unchanged
      with ledger reason "lossy WebP: exact JPEG XL is always larger".
      Lossless WebP is still tried.
      (webp_is_lossy reads RIFF chunks (VP8 vs VP8L, VP8X, first ANMF
      frame) without decoding; ledger preserve reason as above. 4 tests
      red before; pytest converter+tools 317; pinned renpy_demo run
      validator clean. 2026-11-02)
- [x] 25.6 MKV copied unchanged whatever the codec; headless-Chrome
      probe of an MKV+H.264 fixture; content-format / stack.md wording.
      (Any MKV (by EBML DocType, not name) ships byte-identical with a
      preserve step recording codec; a codec no target browser plays
      (MPEG-4 Part 2, MPEG-2, Theora, MJPEG, ProRes, FFV1) still copies
      but gets an item note, ledger warning and summary warning line.
      Chrome 156 headless probe: H.264/VP8/VP9/AV1 MKV play; HEVC only
      with GPU. 3 tests red before; pytest converter+tools 323; real run
      validated and played. 2026-11-02)
- [x] 25.7 Poster recipes recorded; a failed poster drops the item and
      reports it.
      (Poster made first into scratch; failure -> item skipped with note
      + warning naming source and ffmpeg error, nothing shipped, branch
      withdrawal as for other skips; no video-as-poster fallback. Recipe
      gains mode RGB; run_poster_step re-runs a ledger step and the demo
      posters reproduce byte-identical. 6 tests red before; pytest
      converter+tools 329; pinned renpy_demo validator clean.
      2026-11-02)
- [x] 25.8 `kinetic-media ship`: list of sources -> outputs + ledger, no
      story parse; kinetic-extract uses the same media code.
      (media_cli.py + ship.py; JSON array of requests {source, kind,
      startSeconds?, id?}; media-ledger.json = build-ledger sections +
      requests/results (file, poster, size, duration, decision, notes).
      Exit 0 with skips listed, 1 hook raise / unmergeable ledger, 2 bad
      list or tools. Ships merge into one folder (id replaces; same list
      twice = no change). Shares run_asset_pass; kinetic-extract output
      byte-identical before/after on renpy_demo and an rpa project.
      28 tests; pytest converter+tools 357. 2026-11-02)
- [x] 25.9 `kinetic-media rebuild`: from a folder's ledger and the
      original files, verify source/output hashes, non-zero on missing,
      unsupported or mismatched.
      (rebuild.py; exit 0 all match, 1 problems listed as FAIL lines,
      2 cannot start (no ledger, tools differ, bad root). Every source and
      alsoFrom source re-run through one step runner (assets.run_steps,
      shared with conversion; refactor byte-neutral). Hooks matched by
      name + code sha256 per entry; folder checks for extra/missing/
      altered files; --out reproduces media/ byte-identical. 17 tests red
      before; pytest converter+tools 374; real pinned renpy_demo rebuild
      OK. 2026-11-02)
- [x] 25.10 Reuse cache keyed by source hash + recipe + tool versions;
      re-runs encode nothing.
      (media_cache.py under .tmp/kinetic-media-cache/ (KINETIC_MEDIA_CACHE
      =DIR|off): memo by sha256 of {op, post-hook input sha256, recipe,
      mediaTools} -> decision + output sha256; objects verified on read;
      atomic writes; rebuild never reads it. Warm runs make zero encoder
      calls and give identical folders: renpy_demo 0.81 -> 0.34 s; 417
      images via ship 300 -> 14.6 s. 11 tests (7 red before); pytest
      converter+tools 385. 2026-11-02)
- [x] 25.11 Several episodes into one game: kinetic-extract (and ship)
      take several projects in order -> one continuous story, ids kept
      unique, one media folder.
      (kinetic-extract EP1 EP2 ... OUT; ids prefixed epN- only with
      several projects (single-project output byte-identical, proved by
      golden + diffs); slicing options refused with several; storyId/
      title from the first unless given; ledger `projects` + source
      `project`; rebuild takes the roots in order; ship per episode from
      the common parent. 15 tests; pytest converter+tools 400; real
      3-project run validated, rebuilt OK and played. 2026-11-02)
- [x] 25.12 How-to docs (user, 2026-11-02): a practical guide to using
      all of this effectively — setting up and pinning the tools, the
      everyday convert command, writing and packaging a decoder hook
      (EXTRA as the worked example), a game-specific helper delegating
      media to `kinetic-media ship`, combining episodes into one game,
      verifying with `rebuild`, what the cache does, and what to do when
      the self-test or a rebuild fails. In CREATE.md (game makers) with
      reference detail in docs/extracting.md and converter/README.md;
      every command in it run once to prove it.
      (CREATE.md "Converting a Ren'Py project" rewritten as a task guide:
      setup, convert/check/play, episodes, decoder hooks (EXTRA marked
      illustrative only), helper + kinetic-media ship, rebuild on another
      machine, cache, troubleshooting incl. every rebuild FAIL kind.
      Reference updates in extracting.md, converter README (stale MVP
      intro and "menu unsupported" fixed), README, AGENTS.md. Every
      command run in .tmp/howto (episodes, hook, ships, other-machine
      rebuild --out, cache, each quoted failure). pytest tools 130,
      vitest 555. Known: rebuild --out into the folder itself does not
      replace an altered file (documented workaround). 2026-11-02)
- [x] 25.13 Phase-closer: corpus slices re-run (extract, validate,
      play, rebuild), full suite, rebuild demo folders.
      (2026-11-02: /Volumes/Data/games unreadable from the sandbox, so the
      corpus check used the .tmp/f-slice source copy with its
      documented slice command: 4 items, validator clean, rebuild OK,
      played with missingFiles []. vitest 555, biome+tsc clean, pytest
      400, package-proof 18/18 (demo folders rebuilt). Scenario suite
      201 checks: 199 pass, 1 partial, 1 FAIL on "the first Escape while
      fullscreen is the browser's": this run headless Chrome actually
      entered fullscreen and delivered the Escape to the page, which a
      real browser does not; no player code changed in Phase 25; the
      screens re-run gave 49 pass + the usual 2 partials.)

## Phase 26: Bookmark list layout (2026-11-02, user; after Phase 25)

- [x] Bigger bookmark thumbnails in a grid (user, 2026-11-02): the `t`
      list's thumbnails become much larger, and entries fill the screen
      across first, then down (a responsive grid), instead of one
      column. Keyboard/click behaviour, delete (×), scroll-to-latest and
      ordering unchanged. Tests, screens scenario, screenshots at
      1280x720 and 700x900.
      (Grid repeat(auto-fill, minmax(min(100%, 280px), 1fr)): 3 columns
      at 1280x720, 2 at 700x900; thumbnails ~344px / ~280px wide (were
      102 / 128); newest last, list opens scrolled to it; behaviour
      unchanged. Capture cap 320 -> 480px at JPEG 0.8 (~25 KB per
      bookmark, was ~21 KB). 8 unit + 3 scenario checks red before;
      vitest 569, screens 57 + 2 headless-fullscreen partials,
      navigation 21/21, smoke 6/6; screenshots checked. 2026-11-02)
- [x] `e` after visiting a bookmark (user, 2026-11-02): in a converted
      game, after continuing from a bookmark (seen with video bookmarks,
      others untried) `e` does nothing, even when the story from the
      bookmark to the furthest point read was linear. Reproduce (video
      and non-video bookmarks; the bookmark appends to the history), find
      the cause, and make `e` take the reader to the furthest point they
      have read. Test red before; screens/navigation scenario.
      (Cause: recordJump appended the landing as the new end of the
      record, so `e` (go to history end) had nowhere to go. Now the
      landing still appends, followed by a copy of the screens recorded
      after its latest showing; reading on replays them and `e` reaches
      the furthest point read; a different pick forks as after a wheel
      rollback. Not video-specific. machine tests red before (5);
      machine vitest 254, navigation 21/21 (new bookmark check red
      before). screens.scenario's bookmark `e` check updated and lands
      with the Esc-screen item's commit (same file in flight). 2026-11-02)
- [x] Settings live on the Esc screen; `c` dropped (user, 2026-11-02):
      the Esc screen holds the game title, the keys and every setting
      (speed, Tab-skip options, play all routes, Progress group); `c` no
      longer does anything and is removed from help, docs and hints.
      Esc opens and closes it everywhere settings could open before
      (over a choice: countdown frozen; reset box still blocks). The
      keys are laid out in a grid that fills across before going down.
      First-load screen is the same screen. Tests, screens/playall/
      progress scenarios, README/CREATE/docs; screenshots at 1280x720
      and 700x900.
      (Settings mounted inside #help: title, one hint, Keys grid
      (auto-fill, across first: 3 columns at 1280, 2 at 700/800), then
      Settings; fits 1280x720, 700x900, 800x600 without scrolling. `c`
      unmapped. Esc order: reset box, then this screen, then t list,
      else open (incl. over a choice, countdown frozen). Space always
      closes (no button flip); Enter activates a focused control. Demo
      hints updated. 8 unit + scenario checks red before; vitest 561,
      screens 53 + 2 headless-fullscreen partials, playall 27/27,
      progress 6/6, reading 17/17, menus 8/8, media 22/22, smoke 6/6;
      screenshots checked. Includes the bookmark-e screens check.
      2026-11-02)
- [x] Reuse an existing content-addressed file (converting agent,
      2026-11-02): when `media/<h[:2]>/<h>.<ext>` already exists, verify
      its sha256 and leave it untouched (it may be hard-linked into
      another game or test) instead of replacing it; a mismatching file
      is an error naming the path, never silently overwritten. Applies
      to kinetic-extract, ship and rebuild --out. Also fix the stale
      "`c` config screen" comment at machine.ts ~347.
      (media.reuse_existing: a correct existing file is left untouched
      (inode kept, hard links intact); a wrong one is an error naming it,
      exit 1, file unchanged; rebuild --out verifies existing files (FAIL
      line on mismatch). 6 tests red before; re-extract into the same
      demo folder kept every inode; machine.ts comment fixed. vitest
      561. 2026-11-02)
- [x] One video rule (user, 2026-11-02; supersedes 25.6's "MKV copied
      whatever the codec"): a video a target browser can play ships
      byte-identical whatever its container or extension (MP4, WebM,
      MOV, M4V, MKV, ...); anything no target browser can display is
      transcoded to H.264 MP4. One playability table (container + video
      codec) drives it; the MKV-only warning goes (nothing unplayable
      ships). Ledger, rebuild and docs (plan Phase 25 note, stack.md,
      content-format, extracting, CREATE) follow.
      (PLAYABLE_VIDEO keyed by probed container (MP4 brand, EBML
      DocType, ffprobe format; never the name): mp4/m4v h264 hevc vp9
      av1; mov h264 hevc; webm vp8 vp9 av1; mkv h264 hevc vp8 vp9 av1;
      anything else -> H.264 MP4. Headless Chrome probe: audio codec
      never blocked playback, so no audio rule. AVI/TS now transcode
      (were skipped); Ogg transcodes (.ogv not an allowed format). MKV
      warning removed; cache FORMAT 2. 32 tests red before; pytest
      converter+tools 439. 2026-11-02)
- [x] Video playability measured, not assumed (user, 2026-11-02): no
      format restrictions of our own; a video is kept as-is unless it
      will not play, and files must play in Safari. Safari 26 plays MKV
      (user's game), so the earlier "Safari plays no MKV" was wrong.
      Build a local probe page of container x codec samples that reports
      plays/fails (decoded frames, not just audio); run it in Chrome
      here and have the user open it in Safari; then set the rule from
      the results, lift the extension restrictions (schema, validator,
      player), and use lossless remux before re-encode where only the
      container fails.
      Measured 2026-11-02 (Safari 26.6.2 on an M2, headless Chrome 156)
      and agreed by the user: keep as-is when both play (H.264 in
      MP4/MOV/M4V/3GP; HEVC hvc1 in MP4/MOV/M4V; VP9 in MP4/WebM/MKV;
      VP8 in WebM/MKV); remux without re-encoding when only the
      container or HEVC tag fails (H.264/HEVC in MKV/AVI/TS -> MP4;
      hev1 -> hvc1); re-encode to H.264 MP4 only when the codec fails
      in either (AV1, MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263,
      Theora, FFV1, VP8 in Ogg). Audio ignored (the player mutes video).
      No extension list of our own: whatever the rule keeps is allowed.
      (Implemented: keep / remux (stream copy into MP4, hvc1 tag, video
      only) / transcode, detected from bytes; `remux` ledger step
      re-runnable by rebuild; video extension list lifted from the
      schema; cache FORMAT 3. 78 probe samples converted: 29 kept, 18
      remuxed, 31 transcoded; all play in headless Chrome with GPU;
      user confirmed every converted tile PLAYS in Safari 26.6.2 and
      their desktop Chrome (PLAYS* = audio not decoded, irrelevant as
      the player mutes video). pytest converter+tools 478; renpy_demo
      validator clean, rebuild OK. 2026-11-02)
- [x] Phase-closer: full suite, rebuild demo folders.
      (2026-11-02: vitest 569, biome+tsc clean, pytest 478, package-proof
      18/18 (demo folders rebuilt). Scenario suite 209 checks: 206 pass,
      2 PARTIAL (headless fullscreen), 1 FAIL: playall "scenario
      completed" with clickCenter reading an undefined rect in
      configure (harness.mjs:389) under full-suite load; playall re-run
      3x alone: 27/27 each. Same flake class seen once in screens
      (settingsImmediateReload). Follow-up item below.)

## Follow-ups

- [x] Harness flake (2026-11-02): clickCenter (harness.mjs ~389) can read
      an element's rect before it exists/lays out under full-suite load
      (playall configure, screens settingsImmediateReload). Wait for the
      element and a non-empty rect before clicking.
      (Cause: escapeUntil pressed Escape even when its condition already
      held and gave up silently after 3 s, so a slow open left later
      opens out of phase and the stored rect undefined. Now escapeUntil
      skips the press when already satisfied (5 s wait); clickCenter
      takes a selector and waits up to 5 s for a visible laid-out
      element, with a clear error; settings/reset call sites use
      selectors. playall 3x 27/27, screens 3x 57 + 2 partials, full
      suite 211: 209 pass + 2 headless-fullscreen partials. One unrelated
      media check flaked once (video currentTime 0) and passed on rerun.
      2026-11-02)
- [x] `e` after a bookmark outside retained history (2026-11-03, user via
      the game I agent): bookmark, read past HISTORY_CAP (5000)
      so the bookmarked screen is evicted, restore the bookmark, advance
      once, press `e`: nothing happens. recordJump finds no earlier copy
      of the landing (`from` stays -1), so no future is attached and the
      landing becomes the record's end. `e` must still return to the
      furthest position read before the restore, also after advancing
      from the landing and after a reload. Test at the real cap.
      (Rule: a seen landing missing from the record appends the record's
      end again after it, flagged `gap`; `e` goes there and reading on
      records screens just before it until the reader reaches it, reads
      on past it, or jumps again; `u` landings still become the end;
      `gap` persists through storage. New machine tests at the real
      HISTORY_CAP (restore, advance 1 and 3, reload, in-history
      unchanged) failed before the fix. vitest 576, check clean, smoke
      6/6, screens 57 + 2 headless-fullscreen partials. 2026-11-03)

## Phase 27: Converting-agent fixes and timeline navigation (2026-11-03, user + converting agent)

- [x] Nested routes sharing an ending: outer decision after i0 (alt i1
      returns; continuing i2..i4 joins at i5), inner decision after i2
      (alt i3 returns; continuing i4..i4 also joins at i5). Play all,
      reach i5, go back to the outer choice: the outer continuing route
      must be complete and the outer choice must offer the return to
      main. Today it shows both routes seen with no return option.
      (Cause: handleRouteEnd closed only the innermost frame and jumped
      to its continueAt, leaving the outer frame open; the inner return
      row and play-all autoResolve did the same. New join(decision)
      closes an enclosing route whose end the join passes. 4 new
      branches tests failed before; validator accepts the shape (new
      pytest). vitest 580, check clean, smoke 6/6, playall 27/27,
      branches 41/41 (one orchestrator run hung 20+ min in
      branches-unseen and was killed; rerun 41/41 in 67 s; follow-up
      below). 2026-11-03)
- [x] Long choice lists: at 800x600 a 13-route choice runs below the
      window with no scrolling; the last option cannot be clicked and
      keys only cover 1-9. Every option must be reachable by mouse and
      keyboard at small window sizes.
      (Row list scrolls inside the panel, title/status/hint fixed;
      ArrowUp/Down move a row cursor, Enter picks it (Enter's only job,
      at a decision); wheel over an overflowing list scrolls it, else
      walks; next pick / walk highlight scrolled into view; hint past 9
      routes names arrows and Enter. New choicelist scenario (13 routes at
      800x600, click and keyboard pick row 13) 10/10; vitest 601, check
      clean, smoke 6/6; subagent: branches+playall+screens 137 + 2
      headless-fullscreen partials. Screenshots .tmp/choice-overflow/.
      2026-11-03)
- [x] Odd-dimension video conversion: the H.264 re-encode fails on odd
      sizes (e.g. AV1 180x101, 289 skipped). Handle odd dimensions and
      record the recipe in the ledger so rebuild reproduces it.
      (Only odd sizes: -vf format=yuv444p,pad to even,fillborders smear
      of the last row/column (no border, no lost pixels; the 4:4:4 step
      makes pad deterministic, plain pad varied run to run); exact chain
      and a `reason` in the ledger step; even transcodes, remux and posters
      unchanged. New golden ffmpeg.transcode-odd-mp4 recorded with --repin
      from the installed tools. pytest odd/media-tools/setup 54 passed;
      real pinned ship of 180x101 + 180x100 AV1: 2 shipped, outputs H.264
      High yuv420p 180x102 / 180x100, rebuild OK. 2026-11-03)
- [x] Lossless video posters: `kinetic-media ship` posters from the frame
      at startSeconds, JPEG XL when smaller else PNG (same rule as
      images), recipe in the ledger, rebuild reproduces it, old ledgers
      with JPEG poster steps still rebuild. A way to regenerate posters
      for an existing shipment without redoing its videos.
      (Frame at startSeconds -> bitexact PNG -> the image rule: lossless
      JXL verified pixel-identical when smaller, else PNG; full recipe
      in the ledger; old JPEG poster steps still rebuild. Re-running
      `kinetic-media ship` with the same list reuses ledger-recorded
      videos (no transcode/remux re-run) and regenerates posters;
      `--delete-unreferenced-posters` removes only unreferenced ones.
      Golden demo manifest: only the poster line changed. Full pytest
      converter+tools 499 passed; real pinned JPEG shipment -> reship ->
      delete -> rebuild OK, posters .jxl (1.2-1.4x the JPEG bytes).
      2026-11-03)
- [x] Timeline navigation (design in docs/plan.md Phase 27, user
      confirmed): wheel walks the story order along the last-taken
      route at each decision, not the reading history; `e` goes to the
      furthest point read; saved progress and bookmarks migrate
      automatically.
      (Reading record, cap, future copy and gap removed; lastPick per
      decision persisted; wheel walks story order through choice screens
      with the walk's route lit; pure choices walk into the last pick and
      on past the region; `e` = highest seen item. Migration in
      sanitizeContext drops history/historyPos/pass/gap and derives last
      picks; fixture is a real export from 7e420b8. vitest 587, check
      clean; branches 43/43, navigation 21/21, screens 57 + 2 headless-
      fullscreen partials, progress 6/6, playall 27/27 x3 plus two early
      aborts at configure (clickCenter .config-play-all not visible in
      5 s; follow-up below). Screenshots .tmp/timeline-shots/. 2026-11-03)
- [x] Scenario harness: a hung scenario (branches-unseen stalled 20+
      min, 2026-11-03) blocks the run forever. Give each scenario a
      wall-clock limit that fails it with the step it was on.
      (Per-scenario limit, default 300 s = ~3x playall's 97 s,
      KINETIC_SCENARIO_TIMEOUT_MS overrides; FAIL names session + last
      check, Chrome process group killed, run continues, exit 1. The one
      unbounded wait was browser.close() after Chrome acked: now 10 s then
      kill. Orchestrator: 3 s limit -> FAIL "walk", 0 Chrome left; branches
      41/41 three times; one earlier branches run ended 40 checks 39 pass
      1 fail, output not captured, not reproduced in 3 reruns. 2026-11-03)
- [x] Harness flake: playall `configure` intermittently aborts with
      clickCenter ".config-play-all" not visible after 5 s (2 of 5 runs
      on 2026-11-03, after the Phase 27 timeline change; earlier also an
      uncaptured branches abort). Find why the settings panel is not
      open/visible at that point and fix the cause, not the wait.
      (Cause: headless Chrome often hands the fullscreen-leaving Escape
      to the page, so escapeUntil's assumed-swallowed press opened the
      Esc screen and its next press closed it. New pressEscapeSeen probes
      whether the page saw the key; escapeUntil and screens'
      leaveFullscreen use it. Before 3/18 runs failed under load, after
      0/20 (subagent); orchestrator playall 27/27 x3, screens 57 + 2
      headless-fullscreen partials, check clean. 2026-11-03)
- [x] The route pill (`#flash`) can still show when a decision re-opens
      right after a short route and covers the choice title and hint
      (seen at 800x600, .tmp/choice-overflow/cursor-800x600.png). Hide it
      when a choice screen opens, or keep it clear of the panel.
      (Dropped, with its queue, when a choice opens and blocked while
      one is open; the panel fills the window so no clear spot exists, and
      nothing announces at a choice. Play-all's Phase 24 pick unchanged.
      New choicelist check fails with app.ts reverted. vitest 604, check
      clean, choicelist 11/11; subagent smoke 6/6, playall 27/27,
      branches 43/43. .tmp/flash-choice/reopen-800x600.png. 2026-11-03)
- [x] Phase-closer: full suite, rebuild demo folders.
      (2026-11-03: vitest 604, check clean, pytest converter+tools 499,
      scenario suite 11 scenarios 224 checks: 222 pass, 2 PARTIAL
      (headless fullscreen), 0 fail; package-proof 18/18, demo folders
      .tmp/pkg-demo and .tmp/pkg-extract rebuilt.)

## Phase 28: Esc and bookmark screens (2026-11-03, user)

- [x] Esc screen layout: the description beside each key looks bad and
      unaligned. Put it beneath the key, with structure within each
      entry, and clear spacing between the keys area and the settings.
      (Key caps per word with a muted "/" between alternatives, the
      description beneath in muted small text, entries in an aligned grid
      (6/4/3/2 columns by width) with faint row rules; title and close hint
      share a header row; a full-width rule and spacing before Settings.
      Fits 800x600 without scrolling. vitest 604, check clean, screens 57
      + 2 headless-fullscreen partials, smoke 6/6 (subagent).
      .tmp/esc-layout/after-800.png, after-1440.png. 2026-11-03)
- [x] Bookmark screen (`t`) speed: with >50 bookmarks it takes ~3 s to
      open. Open immediately regardless of count and fill in over time
      if needed; optimise generally.
      (Cause: `t` waited for getAll to deserialize every full bookmark row,
      route context and thumbnail included; 60 heavy rows 271 ms, 150 733
      ms here, scaling with save size. Now the panel shows on the next
      frame (<1.1 ms), cards from keys + a per-novel summary cache in the
      existing state store (no DB version bump, older folders keep
      working; heals from keys), thumbnails decoded 4 at a time newest
      first and cached. Old-format rows migrate. vitest 620, screens 60 +
      2 headless-fullscreen partials incl. 60-row open <300 ms check,
      navigation pass. 3 s not reproduced on this machine. 2026-11-03)
- [x] `t` from the Esc screen: opening the bookmark screen from the Esc
      screen replaces it, so a following Esc returns to the game, not to
      the Esc screen.
      (Before: `t` did nothing under the Esc screen. Now `t` or a click on
      the T entry (the one clickable key row, hover cue) opens the list and
      then closes the Esc screen, 0 frames with neither; Esc then returns
      to the game and auto-forward resumes. Inert over a choice or the
      reset box. Biome specificity warnings fixed. vitest 626, check
      clean, screens 66 + 2 headless-fullscreen partials (5 new checks),
      navigation 21/21, smoke 6/6. 2026-11-03)
- [x] Media scenario flake: "the next chain line keeps the same <video>
      playing" intermittently fails with currentTime 0 (closer run, and 1
      of 3 reruns, 2026-11-03; also seen once in Phase 26). Find whether
      the player restarts the chained video or the check samples too
      early, and fix the cause.
      (Check, not player: the sample came 2-15 ms after first `playing`,
      raw currentTime 0.0036-0.014 s, rounded to 0 below 0.005; no
      seeking/emptied/loadstart events on the chained advances. The check
      now records seeks and reloads after playback starts, waits for the
      next presented frame, and requires no reload, no seek but the loop
      wrap, and a media time not behind the pre-advance one. An injected
      `seekTo(element, 0)` on the chain path fails it. Orchestrator: media
      3/3 clean (22/22), vitest 626, check exit 0 with the 3 existing
      warnings.)
- [x] Media range flake: "range-a plays its range [start, end]"
      (insideA false, endedA 0, maxMediaTime 1.48) and "range-b plays its
      range twice" (passesB 1) failed in 3 of 10 instrumented media runs
      during the chain-flake work, 2026-11-03. Find the cause and fix it.
      (range-b, check at fault: Chrome sets `paused` at file end before
      dispatching `pause`/`ended`, so a poll in that gap took the end of
      pass 1 as settled; the settle wait now also needs loopCount `ended`
      events. range-a: advancedMs was timed from Node after the CDP round
      trip (3744/3777 ms under load against 3800); it is now page time
      between poster changes, via a MutationObserver. The maxMediaTime
      1.48 failure did not recur in ~420 runs; its evidence now records
      `pastEnd` frames. Fault injection (one pass short; hold armed 400 ms
      early) fails both checks. Orchestrator: media 3/3 clean, vitest 626,
      check exit 0.)
- [x] Ranged video ends after its hold: `onVideoEnded` ->
      `machine.mediaEnded()` moves forward synchronously, the next item's
      `applyVideoMode` resets `videoEndedCount`, then the old item's stale
      plan seeks to the old `loopStartSeconds` and replays
      (player/src/render/visual.ts; noted in docs/verify-player.md as
      "reported, engine untouched"). Make a stale end never touch the
      next item's playback; add a test.
      (`reportEnd(plan)` counts and reports a pass, then returns whether
      `plan` is still current; `passBoundary`, `onVideoEnded` and the
      autoplay-rejection loop stop when it is not. 3 new tests in
      visual.test.ts fail without the fix (1.5, 0.75, [0,0,1,1]).
      Orchestrator: vitest 629, check exit 0, smoke 6/6, media 22/22.)
- [x] Phase-closer: full suite, rebuild demo folders.
      (2026-11-03 first run: vitest 626, scenario suite 233 checks: 230
      pass, 2 PARTIAL (headless fullscreen), 1 FAIL (media chain
      currentTime 0, item above); package-proof 18/18, demo folders
      rebuilt. Converter untouched since Phase 27's 499 pytest.
      Rerun after the media items: vitest 629; scenario suite 233 checks:
      231 pass, 2 PARTIAL (the same headless fullscreen Escapes), 0 FAIL;
      package-proof 18/18. Pytest not rerun: converter untouched.)

## Phase 29: Safari bookmark thumbnails (2026-11-03, user)

- [x] Safari `t` screen thumbnails: in Safari the panel opens at once,
      then pauses a few seconds and every thumbnail appears together
      (the other agent's game build, many bookmarks). Chrome fills them
      in one by one on the first opening and near-instantly after. Make
      Safari match Chrome: find what Safari waits on, fix it, and prove
      it in Safari.
      (Cause: over file:// Safari refuses to read back a canvas drawn from
      an image ("The operation is insecure"), so image bookmarks have no
      capture (video captures work); their cards showed the 1920x1080
      still, which Safari paints only once every visible one has decoded,
      and decodes again on each reopen. Probed in Safari on the real game:
      87,361 items, 1920x1080 stills. Fix: `shrinkStill` decodes a still
      once off-page into a canvas at capture size, through the same
      newest-first queue, kept for the page's life; fallback to the file.
      New `scripts/bookmark-timing.mjs`. Orchestrator: vitest 631, check
      exit 0, smoke 6/6, screens 66 pass 2 partial (fullscreen Escape);
      Safari file:// high-res fixture, 64 rows: first opening in-view
      cards 68..386 ms one by one, reopens 16-20 ms all at once.)

## Phase 30: Parallel media conversion (2026-11-03, user via the converting agent)

- [x] Parallel `kinetic-media ship` and `rebuild`: poster generation for
      the game I batch has run 8+ hours. Maximise speed:
      profile the serial poster path and remove waste; bounded parallel
      workers starting with posters; dedupe by source hash + frame time +
      pinned recipe before dispatch; JXL encodes single-threaded, with
      concurrency from parallel posters; one coordinator writes the
      ledger in request order and publishes outputs atomically; video
      transcodes under their own lower limit; progress shows completed /
      total requests. Benchmark one cold batch at 1, 2, 4 (and the
      default) workers: output paths, file hashes and request results
      match the serial run; record wall time and peak memory.
      (`--jobs` (default cpu count) / `--video-jobs` (default jobs/4);
      threads, since libjxl/zlib release the GIL and ffmpeg is a
      subprocess; a coordinator plans and dedupes encodes ahead, then
      places records in order with the old code; outputs, ledger and
      rebuild --out written atomically; progress every 10 s on stderr.
      Waste removed: a second full JXL decode per request just for its
      size (now read from the codestream header) and repeated ffprobe
      per file; serial time unchanged (the effort-9 JXL encode is 86%).
      1080p poster batch, 132 requests: serial 1649 s -> 8 jobs 357 s,
      1.07 GB peak, byte-identical at 1/2/4/6/8. Orchestrator: mixed
      batch (27 requests, 9 transcodes) via `.venv/bin/kinetic-media`,
      --jobs 1 359 s vs --jobs 8 88 s (1.06 GB), all 50 files identical
      by sha256; test_media_parallel 24 passed; full pytest 523 passed.)

## Phase 31: Branch map (2026-11-06, user)

- [x] Branch map screen: `m` (and an M entry on the Esc screen) opens a
      zoomable, pannable map of the story's decision tree, drawn from
      the manifest's `decisions` alone (no game-file edits; arrives with
      the usual index.html/app.js upgrade). Each decision shows its
      question and routes with the reader's seen/unseen/played marks,
      the last pick, nesting, continuing vs ending routes and rejoins,
      and where the reader is now. Clicking a reached decision or route
      jumps there; unreached parts are drawn but inert. Wheel/pinch
      zoom, drag and arrow-key pan, a fit/centre control, opens centred
      on the current position; Esc and `m` close it back to the game.
      Must stay smooth for very large games (hundreds of decisions,
      deep nesting, ~90k items).
      (mapmodel.ts: left-to-right layout from `resolveDecisions()`,
      cached per manifest; branchmap.ts: one SVG, culled near the view,
      a few whole-tree paths when zoomed out; jumps via new
      `machine.showChoice(d)` then a real `choose(r)`. Perf, synthetic
      570 decisions / 90k items: open 48-52 ms first, 19-31 ms after,
      frame p95 16.7 ms. Orchestrator: vitest 661, check clean (0
      warnings after removing a stale player/.tmp Chrome profile),
      smoke 6/6, branchmap 15/15, screens 66 pass 2 partial (headless
      fullscreen Esc), branches 43/43, navigation 21/21; screenshots
      checked: demo map correct; large game at fit is a thin strip,
      fixed in the next item.)
- [x] Branch map follow-ups: (1) large games fit as a thin strip, so
      wrap the main line into rows so a fit fills the screen and long
      ending routes don't hang far below; (2) the "Route: ..." pill
      after a map jump draws over the map header; (3) the Esc screen's
      13th row (arrows/Enter) sits alone and at 800x600 pushes Reset
      below the fold: merge the two decision-key rows.
      (Top-level segments wrap into rows, chosen to match the view's
      aspect, never splitting a subtree, with wrap connectors; ending
      routes tuck under their decision, numbered when that breaks
      manifest order. The pill was a reading pill still in its hold when
      the map opened: opening the map now drops pills, and none show
      while it is up. One `1-9 0 ↑↓ Enter` row; 12 rows. Perf 570
      decisions: open 48-58 ms, p95 16.7 ms; fit scale 0.073 (was
      0.012). Orchestrator: vitest 671, check 0 warnings, smoke 6/6,
      branchmap 16/16, screens 67 pass 2 partial (fullscreen Esc),
      branches 43/43; screenshots: large game fit fills the screen in
      rows, Reset visible at 800x600.)
- [x] Phase-closer (Phases 29-31): full scenario suite, full pytest,
      package-proof.
      (2026-11-06: scenario suite 12 files, 250 checks: 248 pass, 2
      PARTIAL (headless fullscreen Escapes), 0 FAIL; full pytest 523
      passed; package-proof 18/18 after regenerating the deleted
      .tmp/extract-demo with kinetic-extract on fixtures/renpy_demo.)

## Phase 32: Branch map feedback (2026-11-06, user)

- [x] Branch map fixes: (1) with the demo fully seen, "you are here"
      is not drawn on the ending's square when the reader is at that
      ending; (2) Fit does not fill the view when the window is
      fullscreen; (3) dragging to pan selects/highlights text.
      ((1) `hereOf` only knew the current stretch: new `endMarkAt` puts
      the marker on the end square at an ending's or the story's last
      screen. (2) Fit included layout padding and a 0.96 factor (~88%
      fill), was capped at 1.4x, and never refit on resize: now fills
      `bounds` less 32 px, capped only by MAX_SCALE 3, and a
      ResizeObserver refits a fitted view. (3) `user-select` was only
      unprefixed and only on the view: now -webkit- too, on the whole
      panel, plus selectstart/pointerdown default prevented.
      Orchestrator: vitest 676, check 0 warnings, smoke 6/6, branchmap
      23/23, screens 67 pass 2 partial (fullscreen Esc); screenshots:
      marker on Route 2's end square, fit fills 2560x1440.)
- [x] Spoilers toggle on the map screen, off by default: when off,
      unseen content shows no text labels. Scope (user chose "a"):
      hide the question of every unreached decision and the labels of
      routes at unreached decisions, tooltips included; routes at
      reached decisions keep their labels (the choice screen already
      showed them). Neutral placeholders; clicking unchanged; the
      setting persists like the other settings.
      (`mapSpoilers` in MachineSettings, default false, so it persists
      and travels in export/import; `markMap` sets `hidden[d]` for
      unreached decisions; `promptText`/`routeText` are the only text
      sources, so real strings never reach the DOM; the hidden tooltip
      is now cleared. Header "Spoilers: Off/On" button and `S`.
      Orchestrator: vitest 682, check 0 warnings, smoke 6/6, branchmap
      29/29, screens 67 pass 2 partial (fullscreen Esc); screenshots:
      placeholders at both sizes, header fits at 800x600.)
- [x] Fit clips the screen-space "you are here" label: at 800x600 on
      the demo's start the marker's label runs off the left edge. Fit
      (and the opening view) must keep the marker and its label in view.
      (`fitView` used `bounds` alone; the marker is screen-space. Now Fit
      solves per axis with the marker's pixel reach (HERE_REACH) as
      extra margin on its side, and the opening view and zoom-out limit
      pass the marker too. Orchestrator: vitest 683, check 0 warnings,
      smoke 6/6, branchmap 32/32; screenshot: label fully in view at
      800x600 start.)
- [x] Choicelist flake: "the route pill showing as a short route
      re-opens the decision goes with it" failed in the Phase 32 closer
      run and 1 of 3 reruns, with {"pillBefore":null,"pillAfter":null,
      "covers":[]}: the pill was never sampled showing. Find whether the
      check misses the pill's window or the player (e.g. the new pill
      gate `coverChanged` / `setPillsCovered`) stopped showing it; fix
      the cause.
      (Check, not player: the first pill shows on a 0 ms timer; the
      check read once a few ms after the click and pressed Space at
      once, so it sampled before the timer or its Space re-opened the
      one-item route's decision first, which rightly cancels the queued
      pill; 7 of 18 traced runs. 82bbd87 not involved. The check now
      records pill/choice transitions page-side, waits for the pill
      before Space, and requires closed,pill,no-pill,open with no
      covered frame. Fault injection (gate off; route pill never shown)
      fails it. Orchestrator: choicelist 3/3, vitest 683, check clean.)
- [x] Phase-closer (Phase 32): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed, converter untouched.
      (2026-11-06 first run: 266 checks, 263 pass, 2 PARTIAL, 1 FAIL
      (choicelist pill, item above); package-proof 18/18, demo rebuilt.
      After the fix: 12 scenarios, 266 checks: 264 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL. One intermediate run
      printed no results and was rerun with its log kept.)

## Phase 33: Branch map simplification (2026-11-06, user)

- [x] Branch map: (1) after a progress reset, "you are here" is not
      aligned over the start symbol; (2) the view defaults to Fit and
      remembers the last view (zoom and position) between openings and
      across reloads; (3) remove the hint and legend lines; each
      button's hover help names its key ("shortcut: F"); (4) remove the
      -, + and Close buttons (keys stay); (5) rename "You are here" to
      "Centre".
      ((1) `hereOf` put screen 1 at its slot along the first stretch,
      not on the start dot (1.8 px off at the opening scale, worse
      zoomed in or with a short first stretch); now cursor 0 is the
      start dot. (2) `mapView {layout, fit, cx, cy, scale}` in the
      story's state record, written on close and pagehide; `restoreView`:
      none or fit -> fresh Fit, else same centre/scale clamped, a new
      layout signature -> Fit; reset deletes it. (3-5) header is the
      title plus Spoilers / Centre / Fit with "shortcut: S/C/F" titles.
      Orchestrator: vitest 695, check 0 warnings, smoke 6/6, branchmap
      42/42, screens 67 pass 2 partial (fullscreen Esc); screenshots:
      three-button header at 800x600, marker on the start dot after
      reset.)
- [x] Phase-closer (Phase 33): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed, converter untouched.
      (2026-11-06: 12 scenarios, 276 checks: 274 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; package-proof 18/18, demo
      rebuilt.)

## Phase 34: Map button hints (2026-11-06, user)

- [x] Map button shortcut hints show at once: the native `title` hint
      appears only after a long delay in Chrome and never in Safari.
      Replace it with the player's own hint that appears immediately on
      hover and on keyboard focus, in both browsers.
      (Pure CSS: `data-hint` drawn by `[data-hint]::after`, shown on
      :hover/:focus-visible with no transition, below and right-aligned;
      `title` removed, `aria-describedby` + `aria-keyshortcuts` kept;
      the bookmark delete "x" moved to the same hint. Orchestrator:
      vitest 695, check 0 warnings, smoke 6/6, branchmap 49/49 (hint
      visible within one frame, in the viewport); Chrome screenshot
      shows "shortcut: F" under Fit. Safari NOT verified: safaridriver
      sessions time out connecting to Safari (subagent and orchestrator
      runs); the user confirmed the hints appear in Safari, 2026-11-06.)

## Phase 35: Bookmarks on the branch map (2026-11-07, user)

- [x] Map shows a sibling ending route after another: in game I, "How does Mara respond to Rowan's offer" has 3
      routes; "Pay Rowan and continue at the office" and "Sign the
      contract" are separate routes that each end the game, but the map
      draws "Sign the contract" as following the office route's line.
      Find whether the player (layout/route resolution) or the game's
      route definitions cause it. If the player, fix it and cover it
      with minimal artificial test data (nothing from that game in the
      repo).
      (Not a player bug: the game's manifest marks "pay" as
      `result: "return"` (a side trip back to the choice), so the map
      correctly draws it into the join and the continuing "contract"
      line after it. The machine, driven with that manifest, loops pay
      back to the choice and never runs the two in sequence. With pay
      set to "ending" (checked on a .tmp copy) the map ends it in an end
      mark. No player change; the fix belongs to the game's
      conversion. Orchestrator confirmed the manifest's route results.)
- [x] Bookmarks on the branch map replace the `t` screen (prototype B,
      user-approved 2026-11-07): each bookmark's thumbnail sits on the
      story line at its exact place (route lines included), stretches
      with bookmarks grow to fit their cards; presets Fit (F) and 100%
      (1, t-screen card size, no overlap); open by click; delete via
      the x at every zoom including Fit, with undo; newest marked;
      `t`/`T` do nothing any more and the T row leaves the Esc screen
      (user, 2026-11-07); no Del or Enter shortcuts on cards. Fix the prototype's pan bug (a drag
      sometimes moves only the thumbnails, not the lines, until 1 then
      F). Remove the `t` screen. Tests use artificial data only;
      game I is for manual checking via .tmp, never committed.
      (2026-11-07: resumed after the usage limit cut off the first
      implementer. Lines, cards and marker now share one stage under a
      single CSS transform (pan desync cause: the prototype's cards were
      a separate will-change layer from the SVG); a new bookmarkmap
      scenario reads pixels after 8 drags and fails under an injected
      freeze. MAX_SCALE stays 3. Orchestrator: npm test 687 pass, check
      clean; full suite 13 scenarios, 304 checks: 301 pass, 2 PARTIAL
      (headless fullscreen Escapes), 1 FAIL = reading still expecting
      the T row, fixed (no c or t), reading 17/17 on re-run; no game I text in the diff (grep); demo-final staged in
      .tmp/corpus-map/; the black card at Fit is that bookmark's own capture
      of a black video frame. Safari not verified: safaridriver
      does not connect.)
- [x] Phase-closer (Phase 35): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed, converter untouched.
      (2026-11-07: 13 scenarios, 304 checks: 301 pass, 2 PARTIAL
      (headless fullscreen Escapes), 1 FAIL fixed before the item's
      commit (reading's stale T row; re-run 17/17); package-proof 18/18,
      demo rebuilt.)

## Phase 36: Card hover shows only the timestamp (2026-11-07, user)

- [x] Hovering a bookmark card on the branch map behaves the same at
      every zoom (Fit, 100% and between): its tooltip gives only the
      timestamp of when the bookmark was made, and nothing else (no
      NEWEST, no "click to continue" or "× deletes" line), ghosts
      included. The Esc screen's M row drops ": click to go there".
      (2026-11-07: showCardTip gives formatTimestamp only, at every
      zoom, ghosts too; × and Undo keep their own hint with no card tip;
      aria-label unchanged. Orchestrator: npm test 688 pass, check
      clean; full suite 13 scenarios, 309 checks: 307 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; bookmarkmap's new tip
      checks fail on HEAD's code (subagent fault run); screenshot shows
      the one-line timestamp tip at Fit; demo-final rebuilt.)
- [x] Phase-closer (Phase 36): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed, converter untouched.
      (2026-11-07: 13 scenarios, 309 checks: 307 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; package-proof 18/18, demo
      rebuilt.)

## Phase 37: Demo builder passes its own check in a clean clone (2026-11-07, user)

- [x] `fixtures/build_demo.py` fails in a clean clone with
      `KeyError: 'videoPath'` (reported by another agent; reproduced in
      a fresh clone of 0aae59f). Cause: its hand-rolled
      `check_manifest` still reads an extension pattern from
      `$defs.videoPath`, which Phase 26 (b64c7fe) removed; checkouts
      with an old gitignored `fixtures/demo/` never re-ran the builder,
      so tests stayed green. Fix the cause, not the lookup: the builder
      checks its output with `tools/validate_content.py` (the shared
      validator) instead of its own copy of the schema rules, keeping
      only demo-specific checks the validator lacks. A test runs the
      builder into a fresh directory and fails on HEAD's code. Output
      stays byte-identical.
      (2026-11-07: the builder runs validate_content.validate_folder on
      its output plus a local every-image-is-960x540 check; its own
      schema copy is gone; `--out DIR` (default fixtures/demo, refuses a
      folder holding subfolders). New tools/test_build_demo.py builds
      into tmp_path. Orchestrator: fresh clone with the change builds
      exit 0, 28 files byte-identical to HEAD's output (taken with the
      broken check bypassed); tools/test_build_demo.py +
      test_validate_content.py 118 pass; the new test fails on HEAD's
      builder in a fresh clone with KeyError: 'videoPath'.)
- [x] Phase-closer (Phase 37): `pytest tools/` in full, package-proof
      (rebuilds the demo); the player and converter are untouched.
      (2026-11-07: pytest tools/ 138 pass; package-proof 18/18.)

## Phase 38: Routes that continue into the join (2026-11-07, converting agent)

- [x] Route `result` `"continue"` (docs/plan.md Phase 38): a route that,
      after its last item, flows into its decision's `continueAt`
      without the continuing route being read first. Play all routes
      off: the join is direct, no choice screen. Play all routes on:
      unchanged contract (every route once this pass, shortest first,
      continuing last, then `continueAt`), so its end re-offers like a
      `return` route's until none is unplayed this pass. Completes only
      itself (the return row still needs the continuing route); counts
      as passing the decision for `u` and the end card; not an ending;
      the timeline walks its end to `continueAt` and back by the last
      pick; the branch map draws it as a join. Schema enum, validator
      (needs `continuingRoute`/`continueAt`), content-format.md
      § Branches, CREATE.md § Branches. Unit tests that fail on HEAD's
      code, and a browser scenario on a scenario-local folder (play-all
      off: pick the `continue` route, its last item steps straight to
      `continueAt`; play-all on: re-offer then join; the map draws the
      join).
      (2026-11-07: machine `endJoins` decides a route end's step
      (continuing always; `continue` with play-all off, or once no route
      is unplayed this pass), used by handleRouteEnd, skip's reveal check
      and `u`'s continuation; `decisionPassed` counts any completed
      joining route; the walk sends a `continue` end to `continueAt` and
      back by last pick, then the continuing route, then the plain step;
      a `continue` route on a decision without `continueAt` drops the
      decision; mapmodel draws it as a join. New continueroute scenario
      on its own folder; demo untouched. Orchestrator: npm test 702 pass
      (one run of seven failed mapmodel's "never overlaps at 100%",
      whose fixture has no `continue` route; six file and four suite
      re-runs passed); check clean; smoke 6/6, continueroute 6/6,
      branches 43/43, playall 27/27, branchmap 48/48;
      test_validate_content.py 121 pass; with `endJoins` ignoring
      `continue` 9 new branch tests fail, restored 142 pass; subagent
      ran the new tests on HEAD's code: 11 of 14 unit, 3 of 4 scenario
      and 3 of 4 validator checks fail, the rest are guards.)
- [x] Route completion follows the route's current end (docs/plan.md
      Phase 38, last bullet): on restore, a completed route whose `end`
      item is not in the restored seen set is not completed (played
      mark kept), so extending a route does not offer "Return to main
      route" past the new content. Unit test that fails on HEAD's code.
      (2026-11-07: the subagent found live play completes an outer
      route without showing its end when a nested decision joins or
      closes past it, so the rule became plan.md's revised bullet:
      end seen, or left past its end through a passed nested decision,
      inner decisions first (`reachedEnd` in applyContext, which reload,
      progress import and bookmark opens all reach). Known gap, left as
      is: play-all + a hand-picked inner continuing route + `u` into a
      sibling whose end auto-resolves past the outer end completes the
      outer route live without the inner decision passed; a reload then
      hides the outer return row until it is completed again. One
      existing test now builds its context with the real mergeProgress.
      Orchestrator: npm test 709 pass, check clean; smoke 6/6, branches
      43/43, progress 6/6, continueroute 6/6; with `reachedEnd` always
      true the 2 machine tests and the codec extension test fail, the
      nested guards pass.)
- [x] Phase-closer (Phase 38): full scenario suite, `pytest tools/`,
      package-proof (rebuilds the demo).
      (2026-11-07: 14 scenarios, 315 checks: 313 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; pytest tools/ 142 pass;
      package-proof 18/18, demo rebuilt.)

## Phase 39: The wheel steps back over unseen content (2026-11-07, user)

- [x] A back notch passes over unseen screens to the nearest seen one
      (docs/plan.md Phase 39): after a route is extended, the wheel
      walks back from its `continueAt` to the last item of the route the
      reader read; also behind a prequel, inserted items or a `u`
      landing. Forward unchanged. Unit tests that fail on HEAD's code,
      and a browser check through a real reload against an extended
      manifest.
      (2026-11-08: `seenBehind` takes the seen step back, else walks
      the story-order step through unseen screens, bounded by screens
      passed; a choice screen counts as seen only with the item under
      it seen; the last pick's join wins whenever its route holds read
      items and every route around its end is the last pick
      (`lastPickJoin`), added after the first round landed play-all
      readers on Negotiate's end. Two Phase 38 walk-back tests now
      expect the abandoned last pick's last read item instead of the
      continuing route's end, matching the forward walk's last pick.
      Orchestrator: npm test 721 pass, check clean; smoke 6/6,
      continueroute 8/8 (its new reload-against-an-extended-manifest
      session fails on HEAD per subagent), branches 43/43, navigation
      21/21, reading 17/17, playall 27/27; with `lastPickJoin` always
      false the 2 new last-pick tests and the 2 rewritten ones fail.)
- [x] Phase-closer (Phase 39): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed unless tools change.
      (2026-11-08: first full run 14 scenarios, 317 checks: 314 pass,
      2 PARTIAL (headless fullscreen Escapes), 1 FAIL = branchmap timing
      out waiting after its window-size checks; branchmap alone 48/48
      twice; full re-run 315 pass, 2 PARTIAL, 0 FAIL; package-proof
      18/18, demo rebuilt; tools untouched.)

## Phase 40: The Transit look and a roomier map (2026-11-08, user)

- [x] Text cuts (docs/plan.md Phase 40, first bullet): the Esc hint
      reads "Esc or Space closes"; map node tooltips and aria labels
      drop "click to go to this choice" and "click to play it from its
      start". Unit tests and any scenario checks that read these texts
      updated.
      (2026-11-08: `HELP_HINT` and `describeTarget` changed; a new
      mapmodel test pins the four status strings and an aria label and
      fails on HEAD's code (subagent swap run). Orchestrator: npm test
      722 pass, check clean; smoke 6/6, screens 66 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; subagent: branchmap
      48/48; the old texts survive only in plan.md/progress.md.)
- [x] Map layout (docs/plan.md Phase 40, second bullet): larger nodes
      (52x28 decisions, 32x24 route pills, rows 42, gap 22, 13 px
      figures centred) and cards without the caption strip (thumbnail
      only, newest outlined, timestamp in the hover tooltip, aria label
      unchanged), rows holding cards sized for the shorter card. Unit
      tests that fail on HEAD's code; `npm run perf:map` against
      docs/perf.md's numbers.
      (2026-11-08: `MAP_GEOMETRY` and `CARD.h` 158 as planned; figure
      baseline `NODE_FIGURE_BASELINE` 4.6, measured with canvas
      `measureText` (digit ink 0.02-0.09 px off the node's centre);
      card bands follow `CARD.h` (above 101 -> 89, below 115 -> 103,
      count line 106 -> 94); the harness reads a card's time from its
      label; README and docs/verify-player.md drop the NEWEST tag.
      Orchestrator: npm test 724 pass, check clean; smoke 6/6,
      branchmap 49/49, bookmarkmap 29/29; screenshots show centred
      figures and caption-free cards. Subagent: new unit and scenario
      checks fail on HEAD's sources; screens 66 pass, 2 PARTIAL
      (headless fullscreen Escapes); perf:map with 180 bookmarks opens
      51.7-64.1 ms (Phase 35: 55-67), frames p95 16.7-16.8 ms.)
- [x] Transit look (docs/plan.md Phase 40, third bullet): the sandbox
      skin's styles written into `player/index.html` as its own rules,
      with the user's changes (scene2 key caps and matching choice
      numbers, plain-text Esc hint, centred delete x). Screenshots of
      every screen against the sandbox's; the full set of hard rules
      checked (story hidden behind Esc, nothing filtered or animated in
      `.map-view`, no network fonts).
      (2026-11-08: index.html's styles reorganised as story band, panel
      tokens, shared components, one section per panel, motion; base
      rules the skin superseded deleted. The delete x is an SVG path
      (`DELETE_CROSS`), 0.01-0.06 px off its circle's centre (the old
      glyph sat 0.7-1.2 px low). Kept from the subagent, against the
      reference: card thumbnails rounded at the bottom, the m row's
      hairline, no transition on the toast's Undo (inside `.map-view`).
      First round let the Esc screen scroll at 800x600; sent back:
      keys and settings now sit side by side from 700 px wide, and the
      screen fits 1280x720, 700x900 and 800x600 with no scroll (HEAD's
      800x600 check restored verbatim, plus a no-scroll check at all
      three). Scenario checks moved to the new look: the M row lit by
      fill, the x drawn, settings beside the keys, labels on one edge,
      Progress buttons on one line, the newest card's gold ring, the
      grey ground's brightness, the map header's height.
      Orchestrator: npm test 724 pass, check clean; smoke 6/6, screens
      67 pass, 2 PARTIAL (headless fullscreen Escapes), reading 17/17,
      choicelist 11/11, bookmarkmap 29/29; 20 screenshot pairs against
      the sandbox differ only in caps, hint, x and card corners; the
      800x600 and 700x900 shots fit unclipped. Subagent: menus 8/8,
      playall 27/27, progress 6/6, branchmap 49/49; no filter, blend,
      animation or transition on the 1,255 elements in `.map-view`;
      perf:map opens 52.5-67.8 ms, frames p95 16.7-16.8 ms (Phase 35:
      55-67, 16.7-16.8).)
- [x] Map lines keep their screen width at every zoom (docs/plan.md
      Phase 40, last bullet), readable far out; measured widths at Fit,
      100% and 3x; `npm run perf:map` against docs/perf.md's numbers.
      (2026-11-08: on HEAD a read stretch painted 12.4 px at the demo's
      Fit (2.44x), 5.1 at 100%, 15.1 at 3x. Every map stroke width and
      dash is now `calc(Npx * var(--line-px))`, `vector-effect`
      removed; `lineScaleStyle` sets `--line-px` on the tree's SVG in
      eighth-octave steps (within 4.4% of the designed width, exactly 1
      at 100%) and stops below `LINE_MIN_SCALE` 0.5, where strokes thin
      with the zoom so a large tree at Fit reads as before. Route
      numbers and counts moved to a `.map-labels` group so a restyle
      skips them. First round cost 5.6-6.4 ms of main-thread work per
      near zoom frame (HEAD 1.5-1.7); sent back; now 2.1-2.2 ms mean,
      60 of 360 wheel steps restyle (docs/perf.md, Phase 40 section).
      Orchestrator: npm test 729 pass, check clean; smoke 6/6,
      branchmap 52/52 (widths 5.14/5.12/5.16 px at Fit/100%/3x; the new
      checks fail on HEAD per subagent), bookmarkmap 29/29; 100% shot
      unchanged, Fit lines now as at 100%. Subagent: perf:map 8 runs
      opens 51.1-68.9 ms, frames p95 16.7-16.8 ms, one unexplained
      283 ms frame in one run, not seen again.)
- [x] Phase-closer (Phase 40): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed unless tools change.
      (2026-11-08: 14 scenarios, 323 checks: 321 pass, 2 PARTIAL
      (headless fullscreen Escapes), 0 FAIL; package-proof 18/18, demo
      rebuilt; tools and converter untouched.)

## Phase 41: One look at every zoom, two views (2026-11-08, user)

- [x] No change of look when zoomed out (docs/plan.md Phase 41): nodes
      and route pills keep their capsule shape, marks and figures, and
      stretches their counts, at every zoom; the far view paints what
      the near view would at the same zoom (a figure left out only
      where a screenshot cannot tell). Screenshot comparisons across
      the old threshold on the demo and the 570-decision tree; unit and
      scenario checks that fail on HEAD's code; `npm run perf:map` opens
      within docs/perf.md's numbers (far-out pan and zoom speed not
      required: the two views remove them).
      (2026-11-08: below `nodeGroupMinScale` the nodes are merged
      capsule paths under the groups' own classes, with figures, pill
      numbers and counts beside them (`mapDrawing`, `treeMarkup`); the
      far-view CSS and skeleton are gone. Counts and figures are left
      out only where their digits paint under one device pixel (below
      0.106x at 1x), which perf:map's 180-bookmark tree reaches at Fit
      (0.103x); there a 1:1 screenshot shows no difference. Orchestrator:
      npm test 734 pass, check clean; smoke 6/6, branchmap 54/54,
      bookmarkmap 29/29, continueroute 8/8; screenshots of the demo at
      0.31x/0.29x and the 570-decision tree at 0.4x and Fit show
      capsules, marks, figures and dashes where HEAD drew plain
      rectangles; perf:map opens 79/58/57 ms, frames p95 16.8 ms.
      Subagent: new unit and scenario checks fail on HEAD's sources;
      perf:map first opens 52-83 ms over 9 runs (3 over 69; HEAD
      52-61), 77-91 ms for the tree without bookmarks at Fit (figures
      drawn). Opening at Fit within docs/perf.md's numbers moved to the
      two-views item, where Fit becomes a still picture and the first
      open is Full size.)
- [x] Band layout (docs/plan.md Phase 41, "Band layout"): the tree is
      cut into bands of a given width at points where nothing straddles
      any line, every line continuing from a tick at a band's right edge
      to a tick at the next band's left; one wrap mark replaces the old
      row connector. Until the two views land, the width comes from
      today's aspect-based choice, so the free-zoom map keeps working.
      Unit tests that fail on HEAD's code (no node, card or count across
      a cut; every cut line continues; a 2,900 px stretch of cards fits
      a 1,440 px band); `npm run perf:map` within docs/perf.md.
      (2026-11-08: the tree is laid out once as a strip (`layOutStrip`)
      and cut into bands at an explicit width (`cutBands`; `bandsShape`
      sizes a cut without building it), cut only where every crossing
      is a straight line; a cut line ends in a 5 px stub crossed by a
      solid slash, resumed by a matching one at the next band's left;
      the wrap link is gone. Bands are sized by what they draw and sit
      `wrapGap` apart (cards 46-62 px apart across bands on the demo,
      116 before the send-back). Interim width chooser
      `bandWidthForAspect` with a 1,280 px floor, so the 3-card demo
      stays one band; item 3 replaces it. Remembered views reopen at
      Fit once (layout signature changed). Orchestrator: npm test 740
      pass, check clean; smoke 6/6, branchmap 54/54, bookmarkmap 29/29
      (its Fit checks now at 960x600), continueroute 8/8, screens 67
      pass, 2 PARTIAL (headless fullscreen Escapes); screenshots of the
      demo with 10 bookmarks and the 570-decision tree at Fit and of
      ticks at 100%; perf:map opens 84.0/53.4/56.8 and
      71.3/66.4/57.2 ms, frames p95 16.7-16.8 ms. Subagent: the 18 new
      or changed unit tests fail on HEAD's sources, the band-height
      test on the pre-fix geometry; node layout 17.8 ms (HEAD 17.4) at
      570 decisions, 130 ms (HEAD 132) at 2,340; first opens median
      73.5 ms against HEAD's 66.2 over 11 alternated pairs, a cold-path
      cost carried to the two-views item, whose Full size opens cut at
      the view width with no chooser.)
- [x] Two views (docs/plan.md Phase 41, "Two views" and "Remembered view"):
      Full size with bands as wide as the view and vertical scrolling (wheel,
      scroll bar, drag, keys), Fit showing the whole map at once and not
      moving, one "Full size | Fit" button with F switching (the 100% button
      and the 1 and 0 keys gone); free zoom and pan gone; C and N go to Full
      size; the view and scroll position remembered, except that after C the
      next Full size open centres on "you are here" again. Scenarios rewritten
      for the new navigation (branchmap, bookmarkmap, screens' map checks);
      first opens (now Full size) and opening at Fit within docs/perf.md's
      numbers, Fit with its counts and figures drawn (items 1 and 2 left
      perf:map's first open at Fit about 7 ms over HEAD's, from the cold cut
      and width chooser, and the tree without bookmarks at 77-91 ms);
      `scripts/mapperf.mjs` measures opens, Full size scrolling and Fit;
      README, docs/verify-player.md and docs/perf.md updated.
      (2026-11-08: header "Full size | Fit" (aria-pressed halves, both
      hinting "shortcut: F"); free zoom, pan, the 100% button and the 1
      and 0 keys removed. Full size is scale 1 cut at the view width
      less 24 px a side (`fullSizeWidth`), scrolled by the stage
      transform with a drawn scroll bar (wheel, thumb drag, track page,
      map drag past 5 px, Up/Down, Page Up/Down, Home/End); just under
      1x only where an uncut span is wider than the view (stacked cards,
      `fullSizeScale`). Fit picks band width and scale together
      (`fitWidth`, largest scale, up to 3x; the 1,280 px floor gone) and
      draws the whole tree once. Record `{ view, layout, place }`, place
      a strip position plus offset or null for centred (C); old records
      read as none. Orchestrator: npm test 745 pass, check clean; smoke
      6/6, branchmap 65/65, bookmarkmap 29/29, continueroute 8/8,
      screens 67 pass, 2 PARTIAL (headless fullscreen Escapes);
      screenshots of the demo and the 570-decision tree at Full size and
      Fit, header on one line at 800x600; perf:map (load 7.4) with 180
      bookmarks first open 69.4 ms, Fit opens 63-65, switch to Fit 48,
      cold Fit open 69.5; without bookmarks first open 57.0, Fit opens
      57-66, switch to Fit 95.9, cold Fit open 93.3; scroll p95
      16.7-16.8 ms. The last two exceed the 52-69 ms guard; accepted by
      the user (no map budget exists, both under the ~100 ms that reads
      as immediate, on a synthetic tree about nine times the largest
      real game; docs/perf.md "Two views"). Subagent: 34 new or changed
      tests fail on HEAD's sources.)
- [x] Phase-closer (Phase 41): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed unless tools change.
      (2026-11-08: `npm run verify`, 14 scenarios, 336 checks: 334
      pass, 2 PARTIAL (headless fullscreen Escapes), 0 FAIL;
      `npm run package-proof` 18/18 steps; pytest not run, no tools
      changed.)

## Phase 42: Even route spacing (2026-11-08, user)

- [x] Route lines spaced by what lies between them (docs/plan.md Phase 42): a
      decision's routes `rowH` apart unless a card, count or node between them
      in x needs more, and each line's offset fixed once for the strip so
      lines continue at the same height across a band cut. Unit tests that
      fail on HEAD's code (a decision with cards on the main line before and
      after it but none in its routes has its routes `rowH` apart; every cut
      line has the same offset from its band's main line on both sides; no
      card, count or node overlaps another); screenshots of the demo with
      bookmarks and the 570-decision tree with 180 bookmarks at Full size;
      `npm run perf:map` and layout time near Phase 41's.
      (2026-11-08: each element carries a line id; `lineOffsets` gives
      every line one height below the main line in one pass (a max tree
      over spans), rowH/2 of room each side plus card room only over its
      cards, as high as clears the lines above where they overlap in x;
      per-band row spreading (`rowOffset`, `cardRows`) gone, bands only
      translate strip content; `fitWidth` counts the ticks' reach. Trees
      without bookmarks lay out identically to HEAD. game I:
      gaps of 42 px between consecutive routes 29 -> 69, card-height
      gaps 44 -> 7 (each explained by a card or nested lines), lines
      changing height at a cut 9 of 47 -> 0 (2000 px) and 14 of 71 -> 0
      (1440 px). Orchestrator: npm test 749 pass, check clean; smoke
      6/6, bookmarkmap 29/29, continueroute 8/8, screens 67 pass, 2
      PARTIAL (headless fullscreen Escapes); branchmap 65/65 in three
      runs, and one run threw mid-scenario (60 checks, cause not
      captured; not seen again); the two branchmap edits (scroll to Home
      before the second C; "whole map in view" counts as an end) follow
      from the shorter demo map; game I cut screenshots join
      edge to edge. Subagent: four of five new tests fail on HEAD's
      sources, the overlap test shown to catch under-spacing by breaking
      the code; node layout 17.8 ms (HEAD 16.7) at 570 decisions, 134 ms
      (HEAD 129) at 2,340; perf:map Full size opens like HEAD's, but
      perf:map's 180-bookmark tree now fits at 0.116x, above the
      figures' 0.106x, so its Fit draws 4,562 texts: switch to Fit
      86-97 ms, cold open at Fit 106-125 ms (HEAD 70-77).)
- [x] Stepped lines, candidate b (docs/plan.md Phase 42, follow-up): on top of
      item 1, each line at the lowest height it needs at each x, stepping by
      an S-bend where a card, count or node above needs room, nested routes
      stepping with it, no cut on a bend. Unit tests (no gap wider than its
      own band's content needs; lines join at cuts; no overlaps); game I staged with a and with b, with screenshots side by side for the
      user; landed only if the user picks b, otherwise noted here and dropped.
      (2026-11-08: dropped, the user chose a. b was built uncommitted:
      `lineProfiles` with S-bends 18 px wide, levels at least 168 px long,
      a's heights kept as floors, bends also on join and return lines, cuts
      kept off bends. game I: 6 bends; line held low with no card
      in its own band 1,057 -> 263 px (2000 px) and 1,237 -> 481 px
      (1440 px); some items moved to the next band. Orchestrator: npm test
      753 pass, check clean, smoke 6/6, branchmap 65/65, bookmarkmap 29/29,
      continueroute 8/8, screens 67 pass, 2 PARTIAL; both demos opened
      headless with no errors. Layout 22.5-24.4 ms against a's 17.3-18.9 at
      570 decisions with 180 bookmarks. Reverted; the working tree is a's
      6f15a77.)
- [x] Phase-closer (Phase 42): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed unless tools change.
      (2026-11-08, on 33ab45b: npm test 749 pass; full `npm run verify`
      14 scenarios, 336 checks, 334 pass, 2 PARTIAL (headless fullscreen
      Escapes), 0 fail, branchmap with no throw; package-proof 18/18. The
      user accepted the slower cold open at Fit on perf:map's 180-bookmark
      tree (docs/perf.md, Phase 42).)

## Phase 43: Game apps, WebKit tests and test speed (2026-11-08, user)

- [x] Test speed without losing coverage (docs/plan.md Phase 43, item 1):
      per-suite timings before and after (baseline 2026-11-08: npm test 5 s,
      check 1 s, pytest 168 s, scenarios about 8 min run serially); the same
      test and check counts; the full suite green twice in a row; AGENTS.md
      test commands updated if they change.
      (2026-11-08: the scenario runner runs files and their independent
      `parts` (eight files now export the sessions they already ran in
      turn) in child processes, 4 at a time by default (`--jobs=N`,
      `KINETIC_SCENARIO_JOBS`), longest first from the last run's times,
      each file's block printed whole in serial order; per-part time
      limit, reaping and Ctrl-C kept. Two Reset-progress races (branchmap
      memory, screens reset) now wait for the reload, and a Chrome that
      dies before it is up gets one retry. pytest-xdist 3.8.0 pinned, run
      with `-n auto`; the demo-building fixture holds a lock. Subagent:
      verify 423 s -> 115-119 s, pytest 149 s -> 46-49 s, npm test, check
      and package-proof unchanged (no change worth making); counts
      identical (749 vitest, 528 pytest, 14 files / 336 checks, 334 pass,
      2 PARTIAL), check names and order diffed against the baseline; two
      green runs each. Flakes seen only at load averages 30-56: the 300 ms
      map open and the 2.00x hold. Orchestrator: npm test 749 pass, check
      clean; `npm run verify` 116 s, 334 pass, 2 PARTIAL, 0 fail; pytest
      `-n auto` 528 passed in 44 s; per-file `check(` counts unchanged.)
- [x] Auto-forward after a restore (item 2): machine unit tests with
      synthetic items that fail on HEAD (restored then `a` moves on after the
      remaining hold; Space ending a skip burst then `a`; the Esc screen
      closing over a restored item in auto), plus "a choice still waits" and
      "the last item stays"; README's `a` bullet still true.
      (2026-11-08: machine.ts `armHold()` arms a settled item's hold under
      auto-forward from `setAutoAdvance(true)` (what is left, from
      `itemShownAt`), `resume()` (fresh) and construction, except while a
      choice is open or when nothing follows: the last item, or a route's
      last item once a pure choice's close has ended the story there (else
      a hold would walk into the next route's items). A settled item passes
      the video gate, so a restored video at the seen edge moves on at its
      time bound instead of stalling. Interface docs for `setAutoAdvance`,
      `resume` and `setSettings` updated; README unchanged and still true.
      11 new tests on synthetic items; the 6 behaviour tests fail on HEAD's
      machine.ts (orchestrator re-ran them against HEAD's file: 6 failed),
      the 5 guards (last item, open choice, play-all countdown timing, the
      pure-choice story end with `ending` and `return` routes) shown to
      catch each exception's removal. One test that expected the old rule
      under auto became its manual-mode twin. Browser check: the demo,
      reload then `a`, HEAD stays on `text-bare`, the fix moves to
      `anim-orbit`. Orchestrator: npm test 760 pass, check clean, smoke 6/6;
      menus, navigation, reading, playall, screens 142 checks, 140 pass, 2
      PARTIAL, 0 fail.)
- [x] Space at a story end inside a closed pure choice (found during item
      2): with a pure choice whose routes run to the end of the item array,
      once every route has played the menu closes and the story ends on a
      route's last item, but Space there steps into the next route's items.
      Space must stay (the end, as at the last item). Machine unit test on
      synthetic items that fails on HEAD; the end card shows as at any other
      end.
      (2026-11-08: one predicate, machine.ts `nothingFollows()` (no decision
      fires and no open route ends on the item, and it is the last item or
      a route's last item with no open frame), now used by `moveForward`,
      skip's dwell, `skipWouldReveal`, `continuation()` (`u`), the end card
      and item 2's `armHold`. Space, the hold and a skip burst stop there;
      the end card shows there for `ending`, `return` and no `result`, and
      under play-all. docs/content-format.md's pure-choice close and End
      card text updated. 10 new branches tests on synthetic items, all 10
      fail on HEAD's machine.ts (orchestrator re-ran them: 10 failed).
      Orchestrator: npm test 770 pass, check clean, smoke 6/6; branches,
      continueroute, choicelist, playall, navigation, reading 127/127.)
- [x] Decoding ahead (item 3): `warmFile` calls `img.decode()`; a unit test
      that a preloaded image is asked to decode and that a failed decode is
      swallowed.
      (2026-11-08: `warmFile` calls `img.decode()` after setting `src` when
      the engine has it, the promise caught. Three visual tests: decode
      asked once per preloaded file (fails on HEAD), a rejected decode
      raises no unhandled rejection and preloading carries on (fails on
      HEAD), an img without `decode` still preloads. Orchestrator: npm test
      773 pass, check clean, smoke 6/6, media, navigation, reading 60/60.)
- [x] Skip notices and both modes on a choice (item 4): "Skip on" and "Skip
      off" pills on every start and stop; `a` and Tab toggle on a choice
      screen with their pill and take effect after the pick; a burst still
      stops at a choice. Machine and render unit tests; scenario checks in
      the matching scenario files.
      (2026-11-08: machine `skipArmed` holds skip turned on at an open
      choice (no timer runs under it); the first item the answer shows
      starts the burst when `skipCanStart()` (something follows and it
      would not reveal), else skip turns off. Every way of leaving a choice
      unanswered disarms it. New `onSkipChange`, the twin of
      `onAutoAdvanceChange`, reports flips of skipping-or-armed; Tab that
      does nothing (nothing seen ahead, or where the story ends) reports
      nothing. main.ts gates `a` and Tab on the panels only. render/app.ts
      lets mode pills (not route pills) show over a choice and merges pills
      announced in one task (mode pills first), so Space ending a skip in
      auto shows "Skip off" then "Auto-forward off". Accepted calls: Space
      taking a play-all pick turns armed skip off; a burst stays armed
      through a play-all auto-pick. 44 new unit tests, most failing on HEAD
      (the `a`-at-a-choice machine test passes on HEAD: only main.ts
      blocked it); 9 scenario checks in navigation, branches, playall and
      menus. README Tab, `a` and Branches bullets and docs/content-format.md
      key rule updated. Orchestrator: npm test 817 pass, check clean; full
      `npm run verify` 14 scenarios, 348 checks, 346 pass, 2 PARTIAL, 0
      fail, 122 s.)
- [x] Esc and M on a choice screen (item 5): dropped (the user,
      2026-11-08). On HEAD both work over a pending choice in Chrome and
      WebKit (probe 2026-11-08, demo outer decision, play-all off).
- [x] WebKit in the scenario suite (item 6): driver and adapter in the repo,
      `npm run verify -- --webkit`, shared web view setup source, loud
      failure on a missing private hook; the full suite on WebKit with every
      remaining engine-aware check explained; Chrome results unchanged.
      (2026-11-09: `apps/macos/WebViewSetup.swift` (one web view setup for
      the app and the driver, macOS 12+), `apps/macos/driver/main.swift`,
      `player/scripts/webkit/` (build on first use into
      `.tmp/webkit-driver-build/<source hash>/`, about 6 s, reused after;
      one plain error without macOS and a Swift toolchain; the puppeteer
      subset adapter). `--webkit` sets `KINETIC_ENGINE=webkit` for the
      runner's children; a preflight builds and starts the driver once and
      stops the run on a missing toolchain, a missing private hook (all six
      reported on the ready line) or a window that would intersect a
      screen; the driver never activates and hands focus back if it ever
      does (front app sampled every 2 s over two runs: never the driver).
      Two checks made engine-aware, each with its reason: branchmap
      user-select (WebKit has only the prefixed property) and screens'
      Space over a focused settings button (macOS WebKit does not focus a
      button on click, so the test focuses it as the keyboard would).
      Nothing written under ~/Library/WebKit. Orchestrator: npm test 821
      pass, check clean; full WebKit suite 348 checks, 345 pass, 3 PARTIAL
      (element fullscreen, off in WKWebView), 0 fail, 176 s; full Chrome
      suite 346 pass, 2 PARTIAL, 0 fail, 137 s.)
- [x] The macOS app (item 7): `tools/build_apps.py --mac [--icon]` and the
      same flags on `assemble_folder.py`; pytest for the options, the
      non-Mac error and the icon; the demo built with the app; CREATE.md,
      docs/packaging.md and docs/stack.md. The user's launch check
      (fullscreen, Esc, reload, Export, Import) moved to the phase closer,
      after item 9 changes the app again.
      (2026-11-09: `apps/macos/app/main.swift` compiles the shared
      `WebViewSetup.swift` with persistent storage; the prototype's
      behaviour without its test hooks, title from Info.plist
      `KineticTitle`, an explaining alert when index.html is not beside
      it, a reload if the page's process crashes. `tools/build_apps.py`:
      `--mac` required (usage, exit 2, without it), `storyId` required
      (bundle id `org.kinetic.game.<storyId>`), safe file name from the
      title, arm64 macOS 12+, ad-hoc signed, built in a hidden folder
      beside the game folder and renamed into place, replaces only an app
      it built; one error and nothing written without macOS and a Swift
      toolchain (`xcode-select -p` checked before `xcrun`). Icon from
      `--icon` (PNG, JPEG, WebP, GIF, JPEG XL via imagecodecs) or the
      first picture in the manifest, centred square, ICNS 32-1024 px.
      48 pytest tests including one real build (codesign --verify
      --strict, plutil -lint, arm64 only, minos 12.0, the shared source
      linked in), three injected faults caught. Orchestrator: pytest
      test_build_apps and test_validate_content 169 passed; package-proof
      18/18; npm test 821 pass, check clean; WebKit smoke 6/6; the demo
      app at `.tmp/p43i7/demo/Kinetic demo.app` is signed ad hoc as
      `org.kinetic.game.kinetic-demo`. Not launched: the user is at the
      machine.)
- [x] The Windows app (item 8): `--windows` builds `<title>.exe` with its
      icon; Go unit tests (file URL, browser lookup), pytest for the option
      and the missing-Go error; the PE's icon resource read back in a test;
      docs. Running it on Windows is the user's check.
      (2026-11-09: `apps/windows/` Go package, no third-party modules:
      platform-neutral `launch.go` (file URL, Edge in all three install
      folders before Chrome, profile folder, arguments) tested on macOS,
      `main_windows.go` the prototype's behaviour split into functions
      (`startBrowser` returns the process for item 9). storyId and the
      percent-encoded title baked in with `-X`. `tools/windows_resources.py`
      writes the `.syso` (one `.rsrc` section: 7 RT_ICON sizes 16-256, the
      256 as PNG, RT_GROUP_ICON, VERSIONINFO with the title and a
      `KineticStoryId` marker that also marks the exe as ours to replace).
      Exe names also replace `\ * ? " < > |` and avoid device names. One
      error and nothing written without Go 1.27+; with both flags every
      requirement is checked first. 51 new pytest tests including a real
      build read back by a PE parser (AMD64, GUI subsystem, baked values,
      each icon decoded at its size, mask bits); 13 injected faults
      caught. Orchestrator: go test ok, `GOOS=windows go vet` clean,
      test_build_apps 99 passed, npm test 821, check clean; the demo exe
      `.tmp/p43i8/demo/Kinetic demo.exe` is PE32+ GUI x86-64, 1.9 MiB. Run
      time unverified here: the user's check at the phase closer.)
- [x] The game's own window controls in the player, the macOS app and a
      browser tab (item 9, first part): Exit and the Fullscreen / Window
      toggle on the Esc screen; the `kineticHost` protocol, its macOS side
      in the shared `WebViewSetup.swift`; the app's display memory and its
      first window size from the first graphic (baked by `build_apps.py`);
      the `index.html` fullscreen changes (re-asked unless the setting is
      Window, skipped when the window fills the screen, Keyboard Lock for
      Escape in Chromium). Unit tests; scenario checks on Chrome and on
      WebKit with the driver's recording host; README and CREATE.md.
      (2026-11-09: `render/host.ts` reads `window.kineticHost` at start and
      on each `kinetic-host` event and sends `{type:"quit"}` and
      `{type:"display", mode}`; with a host the page never asks for element
      fullscreen. The Esc screen's last group, "Game window": a Fullscreen
      | Window switch and Exit (a tab closes only when it can close itself,
      else the screen asks the reader to close it). In a tab the new
      `fullscreen` setting (default on, travels with exported progress,
      old exports read as on) drives re-asking on trusted keys and clicks
      (not Escape, shortcuts, settings controls or a screen-filling
      window) and Keyboard Lock for Escape. `KineticHostBridge` in
      `WebViewSetup.swift` (handler `kineticHost`, document-start script,
      host closures); the app switches window fullscreen on `display`,
      reports the reader's own switches, remembers the mode and its
      windowed frame in UserDefaults and launches in that mode, first
      window from Info.plist `KineticWindowSize` (the first graphic's
      pixel size, written by `build_apps.py`) fitted to the screen with a
      margin. The driver installs the same bridge with a recording host;
      Chrome scenarios use a tiny stand-in. New `window` scenario (host
      and tab parts, 23 checks); screens checks rewritten where Keyboard
      Lock now hands a short Esc to the game. Import's file picker bug
      (a settings click spending the gesture on fullscreen) found by the
      full run and fixed. Orchestrator: npm test 867 pass, check clean;
      test_build_apps 109 passed; full Chrome suite 15 scenarios, 375
      checks, 375 pass, 0 PARTIAL (Keyboard Lock makes the old two
      observable), 0 fail; full WebKit suite 370 pass, 5 PARTIAL (element
      fullscreen, off in WKWebView), 0 fail. The app's on-screen window
      switching waits for the user's check at the phase closer.)
- [x] The game's own window controls in the Edge app (item 9, second
      part): the exe stays running while the game is open and steers its
      Edge over DevTools (binding `kineticHost`, `Browser.setWindowBounds`,
      `Browser.close`), its display memory in the game's profile folder, the
      first window size from the first graphic; a Go client tested against
      headless Chrome on macOS; docs. Running it on Windows is the user's
      check.
      (2026-11-09: standard-library WebSocket (`websocket.go`) and CDP
      (`cdp.go`) clients and a platform-neutral controller: the exe
      launches Edge with `--remote-debugging-port=0` (stale
      `DevToolsActivePort` removed), in the remembered mode
      (`--start-fullscreen`, or the remembered or first window bounds),
      attaches to the page (Runtime and Page enabled, binding
      `__kineticHostSend`, the apps/README.md host script on new documents
      and once in the current one), closes the browser on `quit`, sets
      `Browser.setWindowBounds` on `display`, polls the window once a
      second for the reader's own switches, keeps mode and window bounds in
      `kinetic-window.json` in the profile, and exits with Edge; no
      connection within 10 s leaves the page playing as a tab. First
      window from the baked first-graphic size fitted to the work area.
      A per-launch `kinetic-host.log` in the profile for testing on
      Windows. 30 Go tests, 5 against headless Chrome launched with the
      exe's own arguments (host object before and after reload, page and
      outside switches, memory, quit, a killed browser), 12 injected
      controller faults caught; headless cannot show minimize, slow
      resizes or Edge's real frame. Orchestrator: go test ok, `GOOS=windows
      go vet` clean, test_build_apps 110 passed, npm test 867, check clean,
      window scenario 27/27 on Chrome. Exe now 3.7 MiB. Run time on Windows:
      the user's check at the phase closer.)
- [x] Testing a game with no window on screen (item 10): the library, its
      tests, and a CREATE.md worked example run against the demo on both
      engines.
      (2026-11-09: `player/scripts/testing/kinetic.mjs` `openGame(folder,
      {engine, viewport, profile, closeHelp, playAll})`: refuses a folder
      without index.html and app.js; `auto` picks WebKit on macOS when the
      driver builds, else Chrome, and says which. The handle: `page`,
      `current()` (id, index, text, speaker, file, the open choice and its
      rows), `press`, `spaceUntil`, `waitForItem`, `waitForChoice`,
      `pickRoute`, `reload`, `screenshot`, `errors()`, `close`. No player
      hook: the item is found from the screen plus the manifest, ties
      broken by speaker, picture, then the saved place read from
      IndexedDB. `check-game.mjs <folder> [--engine] [--steps]`. Launching,
      keys and page readers moved from the harness into `testing/core.mjs`
      (the harness re-exports them; no scenario changed). The driver
      takes `--profile=<dir>` for a kept WebKit profile (private API,
      fails loudly if missing; never used by the suite); on WebKit the
      library reports failed media loads, which WebKit does not log.
      CREATE.md "Testing your game" with a worked example, run as written
      on both engines. Orchestrator: npm test 891 pass, check clean;
      check-game on a fresh demo with both apps: no errors on WebKit and
      Chrome; full suites below.)
- [x] Held keys never take the macOS app out of fullscreen (the user's
      play check, 2026-11-09: holding Esc left fullscreen). The page
      consumes a held key's repeats (a repeated mapped key has its default
      prevented and still runs no command), so WebKit hands none back to
      AppKit; and the app's window drops any key the page leaves, so none
      reaches AppKit's own key handling (believed to be what left
      fullscreen: NSWindow keyDown: runs AppKit's keyboard-UI step). The
      WebKit suite checks that held Esc, Space and Tab send nothing back
      to the window.
      (2026-11-09: `installKeyMap` prevents every repeat of a key the map
      owns and of a decision key while a choice takes keys, running no
      command; `DecisionInput { taking, take }`. Shared `KineticWindow`
      in WebViewSetup.swift drops unhandled keyDowns (cancelOperation stays
      empty); the app and the driver both use it, and the driver reports
      each key that comes back (`windowkey`: dropped or appkit) and sends
      `autoRepeat` keys. Window scenario part `heldKeys`: before the fix
      the 15 held repeats came back to the window and reached NSWindow's
      own keyDown; reverting either fix fails its check. Key equivalents
      (⌘Q, ⌘R, ⌃⌘F) still reach the menu. Orchestrator: npm test 898
      pass, check clean, smoke 6/6, window + screens Chrome 99/99, WebKit
      97 pass + 4 PARTIAL (element fullscreen), test_build_apps 110. Real
      fullscreen: the user's check at the closer.)
- [x] The Windows exe on WebView2 (item 11; the user's play check,
      2026-11-09: Edge's fullscreen notice, Esc held left fullscreen, the
      Window half failed until then). Its own window over WebView2;
      fullscreen is the frameless window covering its monitor, so no notice
      and every key is the game's. Same kineticHost protocol; F11 toggles;
      Export to Downloads with no bubble; second launch brings the window
      forward; no runtime falls back to the default browser. Standard-
      library Go, offline build; the Edge launch and DevTools controller go.
      (2026-11-09: controller, CDP and WebSocket code and their headless
      Chrome tests removed; new platform-neutral host.go, runtime.go,
      guid.go, log.go with tests, and Windows-only win32, COM, WebView2,
      window and registry files. The runtime is found from the registry
      (ClientState EBWebView, then Clients pv) and the environment made
      through EmbeddedBrowserWebView.dll's export, as the open-source
      loaders do; vtable indices and interface ids transcribed from
      WebView2 SDK 1.0.4314.35's header, rechecked against its IDL.
      windows_resources.py adds a Per-Monitor-V2 DPI manifest. Window
      memory keeps `maximized`. Orchestrator: go test ok, `GOOS=windows`
      vet and build clean, `go list -deps` standard only, go.mod with no
      requirements; test_build_apps 111; npm test 898, check clean; window
      scenario Chrome 30/30, WebKit 30 + 2 PARTIAL. Run time on Windows:
      the user's check at the closer.)
- [x] ⌘H hides the macOS app (the user, 2026-11-09; found while fixing
      held keys). The key map takes ⌘H as `h` and toggles the text, so the
      app's Hide item never fires, though CREATE.md says ⌘H hides the game.
      The key map leaves a key held with ⌘, Ctrl or Alt to the browser or
      host, as the fullscreen gesture code already does; the plain key
      still works. A WebKit check shows ⌘H reaching the app's menu.
      (2026-11-09: `isShortcut` in keys.ts, shared with fullscreen.ts;
      `installKeyMap` returns before commands and decision keys on it;
      Shift unchanged. The driver's `DriverApplication` makes AppKit's
      key-equivalent pass for ⌘ keys and reports `keyequivalent` lines;
      window part `commandH`: WebKit sees ⌘H claimed by the web view, then
      unclaimed after the page leaves it (where AppKit asks the menu).
      Reverting the page fix fails 3 unit tests, 2 Chrome and 3 WebKit
      checks. The branch map's own arrows and paging keys still ignore
      modifiers (no menu item uses them). Orchestrator: npm test 904,
      check clean, smoke 6/6 on Chrome and WebKit, window + reading Chrome
      50/50, WebKit 50 + 3 PARTIAL (element fullscreen), test_build_apps
      111.)
- [x] The Esc screen's two columns end level again, and its notices never
      move it (the user's second play check, 2026-11-09: a second Export
      on Windows still named the first file; the Settings column ran well
      past the Keys column, more so on Windows). The three notices become
      the auto-forward-style pill: Export done ("Progress exported", no
      file name, since the app or browser may rename it), an Import
      refusal (held longer), and a tab that will not close; both message
      lines go. Progress: "Progress · saved automatically" on its heading
      line, the rest behind a "?" (hover or focus). Auto-forward speed:
      its countdown note moves behind a "?" by the label, and the − slider
      + row spans the cell's full width. Play all routes: a one-line note.
      Game window: heading kept, Fullscreen | Window left and Exit right on
      one row. The Keys card stretches to the Settings column's height, so
      both end level whatever the system font. Docs stop saying ⌘H hides
      the Mac app (it does nothing there; the user doesn't mind).
      (2026-11-09: notices go through the pill queue with a per-message
      hold (`NOTICE_LONG_MS` 4 s for an import refusal and the tab note)
      and a visually hidden `#flash-status` region for screen readers;
      the pill is solid over the Esc screen. "?" tips (`mountTip`) are
      buttons with aria-describedby tips, shown on hover and focus, pinned
      by a click; the glyph is a CSS mask, measured within 0.46 px of the
      ring's centre on both engines. The speed row wraps its readout onto
      its own line when narrow (700 px). Exit's right edge on the cards'
      right edge. Plan item 12. Column bottoms (Keys / Settings, WebKit):
      1920x1080 825 / 824, 1280x720 577 / 575, 800x600 513 / 499; at
      700x900 Keys stretches to Settings. Orchestrator: npm test 911,
      check clean, smoke 6/6 on Chrome and WebKit, screens progress window
      menus reading Chrome 147/147, WebKit 145 + 5 PARTIAL (element
      fullscreen); screenshots checked by eye, `.tmp/escbalance/`.)
- [x] Esc screen follow-up (the user's look at `.tmp/p43play3/demo`,
      2026-11-09; Windows looks the same). The "?" ring sits too low beside
      its text, most visibly by "Auto-forward speed": centre it on the
      text's cap height. The speed readout reads "1.00x (~60 ms/char)",
      not a dash. Play all routes' note moves behind a "?" too. The two
      columns get similar widths, and their heights are balanced again.
      (2026-11-09: the ring is 1.5cap across and rises (1cap - 1ex) / 2
      from vertical-align middle, from the label's own font, with an em
      fallback for older WebKit; measured within 0.78 px of the cap centre
      for all three tips on both engines (before: up to 1.86 px low).
      `speedLabel` gives `1.00x (~60 ms/char)`. Play all routes is a
      one-line row with its tip. Both columns `minmax(0, 430px)`; each
      settings group is one `.config-group` and a shorter Settings shares
      its spare height across the gaps between groups, as a shorter Keys
      card shares it across its rows. Widths 430/430 at 1920 and 1280,
      346/346 at 800x600; natural bottoms within 2.2, 9.8 and 3.3 px,
      level once stretched. A Chrome-only flake in the glyph check (focus
      ring kept across a quick reopen) fixed in the check. Orchestrator:
      npm test 912, check clean, smoke 6/6 on Chrome and WebKit, screens
      progress window menus reading Chrome 151/151, WebKit 149 + 5
      PARTIAL (element fullscreen); ring crops checked by eye,
      `.tmp/escfollow/`.)
- [x] Phase-closer (Phase 43): full scenario suite on Chrome and on WebKit,
      full pytest, package-proof; the user plays the demo's macOS app and
      Windows exe (fullscreen, Esc, reload, Export, Import, Exit, the
      Fullscreen / Window toggle).
      (2026-11-09, automated part on the item 10 tree: full Chrome suite 16
      scenarios, 387 checks, 387 pass, 0 PARTIAL, 0 fail, 138 s; full
      WebKit suite 382 pass, 5 PARTIAL (element fullscreen, off in
      WKWebView), 0 fail, 183 s; pytest 638 passed in 40 s; package-proof
      18/18. The user's first play check found the held-Esc exit on macOS
      and the Edge faults on Windows, fixed by the three items above.
      The second (`.tmp/p43play2/demo`, b088c4b) passed on both apps but
      for the export notice and the Esc screen's uneven columns, fixed
      above; ⌘H still does nothing in the macOS app, which the user does
      not mind. The look at `.tmp/p43play3/demo` asked for the follow-up
      above. The user's look at `.tmp/p43play4/demo` (both apps, built on
      a1ceb1a): "Looks good now". Final automated runs on a1ceb1a: full
      Chrome suite 16 scenarios, 408 checks, 408 pass, 0 fail; full WebKit
      suite 406 pass, 5 PARTIAL (element fullscreen, off in WKWebView), 0
      fail; pytest 639 passed in 69 s; package-proof 18/18.)

## Phase 44: Poster check and fix (2026-11-09, converting agent)

- [x] `kinetic-media posters` (docs/plan.md Phase 44, item 1): check a
      manifest's video posters against the ledger (pixels when the ledger
      has no entry), report and exit 1 on a mismatch, `--first-frame` /
      `--first-frame-all` skips, and `--fix --remap FILE [--out FILE]`
      ships one poster per distinct (video source, start) through ship's
      code. Tests on small ffmpeg-made videos with distinct frames: a
      manifest whose posters are the frames at `startSeconds` exits 0 and
      writes nothing; frame-0 posters on later-start items are each
      listed, exit 1, and `--fix` ships exactly one poster per distinct
      pair, after which the remapped manifest passes; a second `--fix`
      changes no file; first-frame flags skip; a poster without a ledger
      entry is caught by pixels. Docs per the plan.
      (2026-11-09: `posters.py` builds one ledger lookup (entry plus
      `alsoFrom`, the folder's build and media ledgers merged as
      `rebuild` reads them), passes a poster whose `poster` step at the
      item's start (six decimals) came from the video's source sha256,
      fails a recorded other start or source, and compares pixels when
      the ledger cannot say, including a step without `startSeconds`.
      `POSTER_TOLERANCE` 3.0, mean absolute difference per channel,
      measured on corpus 1080p videos and synthetic clips (correct posters
      up to 2.31, wrong frames 0.75-150). `--fix` goes through
      `ship_requests`, now the body of `ship`; it refuses a `--ledger`
      other than the folder's own; `--remap` and `--out` are refused
      without `--fix`. 13 tests. Orchestrator: posters, ship,
      lossless-poster and rebuild tests 65 passed; npm test 912, check
      clean. Real data (a converted corpus game), read-only: 1504 video
      items, 1075 passed by ledger, 429 failed (428 items whose
      posters were made about 3 s into their segment, 127 of them
      starting at 0; one item whose poster is a slide image),
      392 s, mostly the pixel differences; the folder's files and mtimes
      unchanged. `--fix` on a scratch copy of five of those items with
      their decoder hook: 4 requests, remap applied, check exit 0, new
      posters 0.00 from the frame at their start, a second `--fix`
      byte-identical.)
- [x] Validator poster warning (item 2): `validate_content.py --ledger
      FILE` warns, without failing, on a later-start video item whose
      poster's ledger entry records another or no `startSeconds`; output
      unchanged without `--ledger`. Tests for warn, no warn and no
      `--ledger`.
      (2026-11-09: `poster_warnings` applies item 1's ledger rule from a
      local lookup (no converter import): a recorded other start or
      source warns at any start, start-0 items included; no entry or no
      recorded start warns only after 0. Warnings and their count go to
      stderr, so stdout stays problem lines; exit codes unchanged; a bad
      ledger exits 2. `validate_folder` unchanged. Subagent: stdout,
      stderr and exit codes identical to HEAD without `--ledger` on the
      demo, the branches example, a broken copy, a missing folder and
      schema. Orchestrator: validate_content, build_demo and poster tests
      149 passed. Real data (the same game), read-only: 428 warnings,
      exactly the posters check's 428 ledger failures (the
      slide-image poster on a start-0 item, which the ledger cannot
      judge, does not warn); ledger and warnings 1.4 s of a 506 s run
      that is the existing media checks on the external volume; folder
      unchanged.)
- [x] Phase-closer (Phase 44): full pytest, package-proof.
      (2026-11-09 on d1fe1f4: full pytest 673 passed in 55 s;
      package-proof 18/18 after regenerating the deleted
      .tmp/extract-demo with kinetic-extract on fixtures/renpy_demo. No
      player change, so no scenario runs. Phase 44 names of the game the
      request came from were taken out of plan.md and this file.)

## Phase 45: Poster check by item, and dark starts (2026-11-09, converting agent)

- [x] `kinetic-media posters --items FILE` and luma columns
      (docs/plan.md Phase 45, items 1-2): `--items` (JSON array or one id
      per line) limits the check and `--fix` to those ids, exits 2 on ids
      not in the manifest, ignores non-video ids; each `FAIL` line ends
      with the start frame's and the poster's mean luma, and says when the
      start is dark. Tests: a selected subset is the only thing checked,
      reported and fixed (remap and requests hold only listed items); an
      unknown id exits 2; a non-video id is ignored; both file formats; a
      clip that starts black and fades in reports a dark start and a
      brighter poster, a normal clip reports neither; `--fix` twice still
      changes nothing.
      (2026-11-09: `read_items` and `select_items` filter before the
      first-frame skip. The summary reads `N of M video items selected`.
      Unknown ids are named, at most ten. `compare_pixels` returns the
      difference and both Rec. 601 lumas from the frames it already
      decodes. `DARK_START_LUMA` 6.0: fade-in starts measured 0.0-2.4,
      the darkest real pictures 9.9 (credits) and 10.8 (night scenes)
      across 452 corpus videos. The luma fields follow the `(why)`. Tests
      ran red before the code (12 failed); faults with Rec. 709 weights
      and with the poster's luma for the start were both caught. 23
      posters tests. Orchestrator: posters, ship, lossless-poster and
      rebuild tests 75 passed; npm test 912, check clean. Real data (a
      converted corpus game), read-only: an unknown id exits 2 and is
      named; a four-id list reports `4 of 1504 video items selected`.
      The full run gives the same 429 failures in 431 s and leaves the
      folder unchanged. None has a dark start: the lowest start luma is
      17.8, and 30.3 among the 128 that start at 0 (median 84.9).
      AGENTS.md's posters bullet now names `--items`.)
- [x] Phase-closer (Phase 45): full pytest, package-proof.
      (2026-11-09 on d2e349f: full pytest 683 passed in 81 s;
      package-proof 18/18, with .tmp/extract-demo regenerated from
      fixtures/renpy_demo. There was no player change, so no scenario
      runs.)

## Phase 46: Large-game checks and fast saves (2026-11-09, converting agent + user)

- [x] Player: fast saves that still flag inserted content (docs/plan.md
      Phase 46, item 1): a screen change does no work in proportion to
      the number of seen items, in the machine or in storage; old saves
      and exported progress still load; inserted content stays unseen.
      Tests:
      - a unit test that a save on an advance writes only what changed
        (the new seen id and the small state), not the seen list;
      - an old-layout save (fixture) loads with every seen id, and the
        next save and reload keep the same seen set;
      - a progress file exported before the change imports;
      - a save made against a manifest, opened with a copy that inserts
        items into read content: the resume notice shows, `u` lands on the
        first inserted item, skip stops at it, the end card counts it;
      - Reset progress clears the seen records;
      - measured (docs/perf.md): Space on WebKit and Chrome with 100 and
        160,000 items seen, before and after; after, p95 under 10 ms at
        160,000 seen on both engines (before: 49 ms on WebKit; 5 ms at
        1,000 seen).
      (2026-11-09: the seen set has records of its own in the existing
      `state` store (database still version 1, no new store or index),
      keyed `["seen", <storage key>, <page>, <n>]`, at most 500 ids each,
      written only by the page load that saw them. The machine keeps a
      seen log (`exportPlace()` without `visited`, `seenSince(from)`);
      storage/saves.ts takes the new ids when a write goes out, so the
      writer's coalescing drops none. The state record keeps the small
      context and `ctx.lastShown`, with `visited: []`. The first load
      moves an old `ctx.visited` list (an old save, an older build's write,
      an import) into seen records in one transaction, merges part-filled
      records past 32 and drops seen records with no state record; an
      older build then shows fewer seen items, documented in idb.ts.
      Bookmarks store `visited: []` (a restore only unions it); the export
      file is unchanged; routes.ts no longer sorts the seen set on every
      state change. Tests ran red first: a save writes the same bytes at
      100 and 10,000 seen; a 650-id pre-change fixture loads whole and
      moves to 500 + 150 records; a pre-change export imports; the content
      update in unit tests and a new screens part `insertedContent`
      (notice, end card, `u`, Tab); Reset clears the seen records;
      carry-over moves them. New harness `npm run perf:save`
      (saveperf.mjs, 161,000 screens, 28-character ids); docs/perf.md
      "Saves at scale". Orchestrator: npm test 939, check clean, smoke
      6/6; Chrome progress, storyid, screens, bookmarkmap, reading,
      branches, playall, continueroute, navigation 304/304; WebKit
      progress, storyid 11/11, screens 87 pass and the 2 usual fullscreen
      partials. perf:save rerun: at 160,000 seen press p50/p95 1.2/2.6 ms
      on WebKit and 1.0/3.0 ms on Chrome (before 6.9/42.9 and 9.0/11.0);
      the one-time move adds about 30-100 ms to the first load.)
- [x] Player: the item on screen on the page (item 2): the stage's
      `data-item` is the id of the item whose screen is shown. Tests
      (creator scenario part, Chrome and WebKit): it matches each step of
      a demo walk, an open choice, the Esc screen and the map; it changes
      in the same frame as the screen.
      (2026-11-09: render/app.ts sets `data-item` from
      `manifest.items[state.cursor]` in the same synchronous render that
      applies the visual and the caption, and removes it when no item is
      shown (the empty manifest). Under a choice it names the cursor: the
      decision's `after` item on a first offer, the route's last item at a
      re-offer, which is what the screen shows and what `current()`
      infers; the Esc screen and the map leave it alone. Tests ran red
      first: 4 app.test.ts units (real shell and machine over a fake
      document); creator parts `stageItemWalk` (all 32 demo ids equal
      `current().id` step by step, under choices and re-offers, the Esc
      screen and the map, no attribute in the empty folder) and
      `stageItemFrames` (every rAF frame and MutationObserver batch pairs
      the id with its own line and picture). Setting the id one frame
      late, in rAF or setTimeout(0), failed all four checks on Chrome and
      WebKit. Orchestrator: npm test 943, check clean, smoke 6/6; Chrome
      creator 19, reading 17, branches 47, playall 29; WebKit creator 19;
      all pass.)
- [x] Player: open at an item from the URL (item 3): `#start=<id>` opens
      there, entering its routes as `u` does; the hash is removed after;
      an unknown id warns and opens as usual. Tests (unit and a scenario
      part on both engines):
      - a main-line item, an item in a nested route (Space carries on
        inside the route, the routes marked played), and a decision's
        `after` item (Space opens the choice);
      - a reload after the start resumes the saved place;
      - an unknown id: one warning, the usual first screen.
      (2026-11-09: machine.ts's new `enterRoutesAround(index)` holds what
      `u` did inline (frames from `framesAround`, routes played and picked)
      and `jumpToUnseen` calls it; a new construction option `startAt`
      restores as usual, then enters the start item in place of the
      landing, so a fresh profile does not mark item 0 seen and a stored
      choice is not reopened. render/urlstart.ts parses `#start=<id>`
      (URL-decoded; undecodable counts as unknown), removes the hash with
      `replaceState` keeping path and query, and warns once for an
      unknown id. main.ts saves right after a start and shows no resume
      notice on one. The WebKit driver keeps the fragment, so no driver
      change. Tests ran red first: 5 machine units, 15 urlstart units, 4
      branches parts (main line, nested route `nest-continue`, decision
      `branch-decide`, unknown id; hash gone, reload resumes the saved
      place). Orchestrator: npm test 967 (one mapmodel timing test
      failed once at load average ~90 from other sessions and passed
      alone and in a full rerun), check clean, smoke 6/6; Chrome branches
      61, playall 29, progress 7, creator 19, navigation 24; WebKit
      branches 61; all pass.)
- [x] Testing library (item 4): `current()` reads `data-item`, else the
      index (with the tie cache), and says how it found the id;
      `startAt`; the symlink note; failed loads reported once on both
      engines. Tests (kinetic.test.mjs and creator scenario parts on both
      engines):
      - the existing `matchItems` cases pass; the index gives the same
        hits on a generated manifest with repeated lines and pictures;
      - a folder with the old player (its app.js from before item 2) is
        named from the screen, ties by the saved place;
      - `startAt` lands on the item; an unknown id throws before a browser
        starts; a player without item 3 is refused with the reason;
      - a symlink out of the folder is named in one note on both engines;
        one inside the folder is not;
      - a missing picture, an undecodable picture and an undecodable video,
        each mid-walk, give exactly one line on each engine.
      (2026-11-09: `current()` reads `data-item` in the same round trip
      and reports `foundBy` (player, screen, saved place, guess, none);
      without it, core.mjs `indexItems`/`lookupItems` give `matchItems`'s
      hits from two Maps built once per handle, then `narrowItems`, the
      saved place and `nearestAfter` (pure `findItem`). No tie cache: the
      orchestrator dropped it (plan amended). `openGame({ startAt })`
      checks the id against manifest.js or manifest.json before any
      launch and refuses a player that does not land there. The symlink
      scan (53 ms on 50,000 files) logs one note on both engines. The
      page tracks every img/video src and poster; a load that never
      finished (aborted when the walk moved on) or a poster is checked
      off the page when `await game.checkMedia()` drains; failures log
      once per URL, merged with Chrome's own line. collectErrors now
      keeps Chrome's `warn` (it only matched `warning`, so Chrome
      warnings were never reported); the two warnings that exposed came
      from the bookmarkmap and branchmap screenshot readers
      (`willReadFrequently` added), none from the player. Tests ran red
      first: unit tests for the index (3,000-item generated manifest),
      `findItem`, `startAt` refusals and the scan; creator parts on both
      engines for player naming, an older player (simulated) named from
      the screen with twins by the saved place, `startAt` and its
      refusals, the symlink note, and a missing picture, an undecodable
      picture, video and poster walked past at check-game pace. The first
      round met everything but a video passed at check-game pace (no
      error on either engine); it went back for `checkMedia()`.
      Orchestrator: npm test 986, check clean, smoke 6/6, full Chrome
      verify 444/444 (first round), creator 29/29 on Chrome and WebKit,
      WebKit bookmarkmap 29 and branchmap 65; a check-game-pace walk of a
      broken demo copy past the faults (13, 20 and 31 steps) then
      `checkMedia()` lists the three faults once each on both engines,
      the clean demo none, in about 55 ms.)
- [x] check-game.mjs (item 5): `--steps all`, the end stop, the stuck
      stop, the heartbeat, the summary, `--start-at`, `--until`, exit
      codes 0/1/2/3. Tests (a scenario part running the CLI on demo
      copies, both engines):
      - `--steps all` on the demo stops with `story ended at step N` at
        the demo's last screen, exit 0, all items visited;
      - `--steps 1000` on the demo stops at the same step;
      - a linear copy stops at its last item;
      - a copy with an item Play all routes never reaches exits 3 and
        names it; with a console error as well, exit 1;
      - `--start-at` a late item prints it first; `--until` stops there;
        an unknown id exits 2; `--until` an item the run does not reach
        exits 1;
      - the heartbeat appears on stderr when its interval is shortened
        for the test.
      (2026-11-09: the walk's decisions are a pure module, walk.mjs
      (`readArgs`, `startWalk().see()`, `exitCode`, cap `2n+1000`, stuck at
      5 unchanged presses over 2 s), driven by a rewritten check-game.mjs
      whose `  N: <summary>` lines are unchanged. The end is an unchanged
      press with the end card up (`current().endCard`, new) or on the
      manifest's last item. After an unchanged press it waits 100 ms, so a
      stuck player is ~20 presses. The heartbeat (stderr, 30 s,
      `KINETIC_CHECK_GAME_HEARTBEAT_MS` for tests) names the step, items
      seen and screen; `checkMedia()` runs before errors are read, with a
      stderr note from 100 files. Ids are checked against the manifest
      before any browser starts (`readManifestFile`, now exported). Tests
      ran red first: walk.test.mjs 28 (each of 9 injected faults caught);
      new checkgame.scenario.mjs, 16 checks per engine (demo `--steps
      all` ends at step 35 with 32 of 32 visited; `--steps 1000` the same;
      a linear copy; an unreachable item between `route2-end` and
      `after-start`, which the validator accepts, exits 3, and 1 with a
      missing picture; `--start-at`/`--until`; unknown ids exit 2; the
      heartbeat; a pure-choice ending stopped by the end card alone; a
      stuck player). A 5,000-item generated game walked to the end in
      4.8 s on Chrome and 8.6 s on WebKit. Orchestrator: npm test 1014,
      check clean, smoke 6/6; checkgame 16/16 and creator 29/29 on both
      engines; on an assembled demo `--steps all` ends at step 35, exit 0
      on both engines, a random-bytes video gives one error line and exit
      1, `--start-at route1-start --until after-start` stops there, an
      unknown id exits 2.)
- [x] Player: videos always fill the stage (item 6, user): a video
      sometimes plays smaller than the stage; scrolling back and Space
      usually fixes it; trigger unknown. Find the trigger and fix the
      cause. Tests (a scenario part on the engine(s) where it happens,
      red before the fix):
      - the reproduced trigger, with the video's painted box measured
        against the stage, as its poster and pictures fill it;
      - the same check after Space, the wheel, skip, a jump, a restore,
        a resize and a fullscreen change onto a video item.
      (2026-11-10: NOT REPRODUCED headless; shipped as a mitigation by the
      user's choice. The user sees it in Safari and the macOS app, already
      fullscreen, after a long session of pictures and videos, with an
      earlier still around the small video (no black bars). Every listed
      path on both engines at 1280x720 and 1920x1080, and three long
      WebKit walks (715 video showings over many sizes, ranges, real-size
      content), painted every video within 3 px of its `contain` box with
      the `<img>` hidden. WebKit draws video in a GPU layer that the
      off-screen driver never shows, and its snapshot paints the frame in
      software at the right size, so no headless test can fail for this.
      Likely cause: WebKit's per-element video layer state carried across
      sources on the one reused `<video>` (frames drawn smaller than the
      element while its poster background fills it; WebKit bugs 241789,
      240604). Mitigation in visual.ts: a fresh `<video>` per new source
      file (`retireVideo()` pauses it, drops listeners and src, calls
      `load()` and removes it); ranges of one file, loops, replays, seeks
      and text chains keep their element. Tests: 6 visual.test.ts units
      (4 red before); new videofit.scenario.mjs (14 path checks plus an
      `elements` part: one `<video>` at a time, a fresh one per file,
      released ones empty; red on HEAD for the fresh element). WebKit's
      first video frame comes later (p50 19 -> 27 ms, p95 37 -> 81 ms)
      while the poster still paints at ~10 ms, which is what the
      navigation budget measures; Chrome unchanged. WebKit snapshots with
      a black box on a video-to-video step: 45 of 104 steps before, 20
      after; Chrome none. Orchestrator: npm test 1020, check clean, smoke
      6/6; Chrome videofit 22, reading 17, navigation 24, media 22 (two
      timing checks failed once at load average ~25-47 from other
      sessions, then 22/22 twice); WebKit media 22, videofit 22, creator
      29. If the user sees it again: WebKit `Fullscreen=debug` logging of
      the app during a bad showing, as a new item.)
- [x] Docs (item 7): CREATE.md, docs/perf.md, docs/verify-player.md,
      AGENTS.md.
      (2026-11-09: CREATE.md "The quick check" rewritten (options, how the
      end is recognised, stop and summary lines, heartbeat, media check,
      an exit-code table, real demo output on both engines, a late-content
      example with `--start-at`/`--until`, a coverage example exiting 3);
      the library reference gains `startAt`, `foundBy`, `endCard`,
      `checkMedia()` and the symlink note, and the sample script awaits
      `checkMedia()`; "Playing the folder" describes `#start=`; the Mac
      app bullets note that links out of the folder load nothing; the
      upgrade guide covers the new progress layout (older players see
      fewer items seen, nothing lost) and that `ctx.visited` is now empty
      for scripts that read it. AGENTS.md's check-game line has the new
      options and exit codes. docs/perf.md, docs/stack.md and
      docs/verify-player.md were updated by items 1-5. Writing the docs
      found a bad `--engine` exiting 1 and a media-check stall missing
      from the exit list; item 5's subagent fixed both (readArgs refuses
      the engine, exit 2, test red first). Orchestrator: npm test 1014,
      check clean; `--engine safari` exits 2 with no browser; the
      documented demo outputs match real runs.)
- [x] Phase-closer (Phase 46): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof; a timed
      `check-game --steps all` walk of the synthetic 160,000-item game on
      both engines.
      (2026-11-10 on ab506f4: full pytest 683 passed in 87 s; full
      `npm run verify` 483/483 on Chrome; `npm run verify -- --webkit`
      481 pass and 5 partial (the headless fullscreen checks), 0 fail;
      package-proof 18/18 with .tmp/extract-demo regenerated from
      fixtures/renpy_demo. `check-game --steps all` on a synthetic
      160,032-item game (the demo plus a 160,000-item body, ids padded to
      the real length, the last screen shared by 19 items; the validator
      passes it): `story ended at step 160035`, `visited 160032 of 160032
      items`, no errors, exit 0, in 381 s on WebKit (2.4 ms a step) and
      198 s on Chrome (1.2 ms a step); heartbeats every 30 s. Before this
      phase a step on that game grew from 3.6 to 21.3 ms on WebKit as the
      reading went on (plan table), and the converting agent's 159,609-item
      walk took 57.5 minutes.)

## Phase 47: Audio (2026-11-09, user + converting agent)

- [x] Audio in the content format (docs/plan.md Phase 47, item 1):
      top-level `audio.tracks` and per-item `audio` (`music`, `ambience`,
      `fadeMs`, `sfx` with `delayMs` and `channel`, `voice`,
      `videoSound` with `duck`). Covered in docs/content-format.md
      ("Audio", with path-following resolution), the schema and the
      validator. Tests:
      - a manifest using every field passes;
      - each rule fails its own case: a missing file, an unknown id,
        `videoSound` on an image item, a `videoSound` track shorter than
        the range, a duplicate ambience id, a volume of 1.5, item `audio`
        with no tracks;
      - an Ogg track warns on stderr and leaves the exit code alone;
      - an unused track warns;
      - the validator's output on fixtures/demo and the branches example
        is unchanged.
      (2026-11-09: the schema keeps `videoSound` to video items through
      a shared field list and `unevaluatedProperties: false`; track ids
      have the item id shape; `iter_media_paths` yields track files, so
      they get the existing existence and path-rule checks.
      `audio_problems` covers track ranges, item `audio` without tracks
      (one problem per item), unknown ids in all five places, duplicate
      ambience and a `videoSound` track short of the range end by over
      0.05 s. `audio_warnings` covers Ogg and unused tracks, as
      `warning:` lines plus a count on stderr; exit and stdout are
      unchanged. A track's `loopStartSeconds` defaults to its
      `startSeconds` (plan amended: a Ren'Py `<from N>` loop restarts at
      N). 41 new tests, 40 red against HEAD. Orchestrator:
      test_validate_content and test_build_demo 184 passed; HEAD and the
      new validator give identical stdout, stderr and exit on 13 folders
      without audio (the demo, the branches example, 11 broken
      variants); npm test 912, check clean.)
- [x] kinetic-media `audio` kind (item 2): keep MP3, M4A, WAV, FLAC and
      WebM; copy Ogg Vorbis or Opus into WebM without re-encoding;
      re-encode the rest to Opus in WebM; audio from a video, with a
      loudness check (`silent` and `no audio` results); durations by
      decoding; ledger steps, rebuild, cache and `--jobs`; self-test
      cases with goldens recorded by `--repin`. Tests:
      - each keep format ships byte-identical;
      - an Ogg Vorbis and an Ogg Opus source ship as WebM that decodes to
        the source's samples;
      - an AIFF source ships as Opus WebM;
      - a VBR MP3 whose header misstates its length gets its decoded
        duration;
      - a video with a tone ships the tone, one with a silent track says
        `silent`, one with none says `no audio`;
      - shipping twice is byte-identical, and the second run encodes
        nothing;
      - `rebuild` reproduces every audio file, and a changed byte fails
        it.
      (2026-11-09: `probe_audio` ignores `attached_pic` cover art;
      KEEP_AUDIO and COPY_AUDIO mirror the video tables; a copied MP3
      gets `-write_xing 0 -id3v2_version 0`, since with a Xing header
      ffmpeg trims 529 samples the source never trimmed; a re-encode of
      more than 2 channels downmixes to stereo. `run_steps` takes each
      step's extension from its muxer. Durations are decoded samples
      over rate, cached with loudness; a file that will not decode is
      skipped. SILENT_MAX_VOLUME_DB -70: 9,470 loose corpus videos,
      2,309 with an audio stream, 1,666 of them silent at -91.0 or
      -90.3 dB, the other 643 at -45.4 dB or louder. Self-test cases
      ffmpeg.audio-remux-webm, -transcode-opus, -extract-m4a, -duration
      and -loudness, recorded by the orchestrator with `--repin` (the
      user's choice, 2026-11-09; AGENTS.md now says so): 69e0b40f,
      6d4cf83d, 72dc5993, e5a7e3e6, 11a68be9; setup's self-test passes
      21 cases. 58 audio tests, red first (`audio` refused as a kind);
      4 of 5 injected faults caught (dropping the early silent return
      only wastes an encode). Subagent: full pytest 783. Orchestrator:
      audio, ship, media-tools and setup tests 128 passed; npm test
      912, check clean; real `kinetic-media ship` with the pinned tools
      on 81 corpus requests (60 audio files, 21 videos; read-only,
      output in .tmp) exit 0, `rebuild` 70 of 70 matched, a second ship
      left the ledger byte-identical. Not changed: a pre-existing
      video-path ledger note that drops on re-ship when two sources
      give identical transcodes; fixed on the audio path only.)
- [x] `fixtures/audio-demo` guided tour (item 3), built and validated by
      `fixtures/build_audio_demo.py`, every line saying what to hear.
      Tests: a fresh build validates; building twice gives identical
      files; the manifest exercises every audio field.
      (2026-11-09: 35 items in sections for music (a 4 s crossfade, a
      fanfare with `loop: false`, a track with `startSeconds` 6 and
      `loopStartSeconds` 3, `music: null`), ambience (two loops, the set
      shrinking, `[]`), one-shots (`delayMs`, a channel cut, an
      overlap), voice (an 8.4 s line that outlasts its text), a
      decision whose continuing and `continue` routes set different
      music and join at a `continueAt` that sets none, a ranged video
      with a synced `videoSound` ducking to 0.3, and an item pinning
      both channels. 15 tracks in M4A, WebM Opus, WebM Vorbis, MP3 and
      WAV, durations from decoded samples; 1.4 MB. build_demo.py's
      helpers became module-level for reuse; its output is unchanged
      (all 28 file hashes). fixtures/audio-demo is gitignored like
      fixtures/demo. 26 tests, red first (no builder). Orchestrator:
      build_audio_demo, build_demo and validate_content tests 210
      passed; the demo rebuilt to the same hashes; the audio demo
      assembled with tools/assemble_folder.py plays 36 screens in
      check-game.mjs with no console or page errors in Chrome and
      WebKit.)
- [x] Player: target sound and arrival kinds in the machine (item 4).
      Tests (Vitest):
      - a route start inherits from its decision's `after` item;
      - a join follows the last pick and changes when the pick changes;
      - an item that sets both channels ignores the path;
      - silence before any change;
      - choice screens and the end card keep the previous sound;
      - every move gets its arrival kind: Space, auto-forward, a pick,
        play-all's pick and a join are `read`; Tab is `skip`; the wheel
        is `walk`; `e`, `u`, a bookmark, a map click and a reload are
        `jump`;
      - `transition` is unchanged everywhere;
      - resolution on the 160,000-item synthetic manifest takes under
        1 ms per arrival (p95).
      (2026-11-09: accessors beside `subscribe`, not state fields, so
      whole-state test comparisons stay valid: `arrival()` gives
      `{kind, number}` (the load is arrival 1, a `jump`) and
      `targetSound()` gives `{music, ambience, voice, videoSound}`,
      cached per arrival. machine/sound.ts resolves along `stepBack`,
      lifted out of `seenBehind` so the wheel and sound share one path;
      runs whose step back is always the item before get the nearest
      setter precomputed, and a walk steps back only at a run's first
      item. Kept answers drop on a new last pick, an applied context
      and a first sighting at a run edge. Kinds pass from `moveForward`
      and `skipTick` through decisions, route ends, joins and closes;
      `choose(..., "map")` is a `jump`. Choice screens carry the target
      of the item under them. A continuing route started after a
      returning route takes the sound that route left, as Ren'Py's
      menus do. 37 new tests, 32 red first; two property tests
      (resolution equals a wheel walk for random picks, and a reloaded
      machine after every move); 5 injected faults all caught after the
      detour test. `npm run perf:sound` (M2, loaded): p95 0.0002 ms
      reading, 0.0011-0.0015 ms on random jumps, 0.15 ms with a new
      pick before every jump; table build 17-23 ms on first use;
      docs/perf.md "Target sound (Phase 47)". Orchestrator: npm test
      949, check clean, perf:sound p95 0.15 ms on the stress series,
      full Chrome scenario suite 408 of 408 (machine paths for picks,
      joins, skip and the wheel changed).)
- [x] Player: playback (item 5): elements, crossfade, the ambience set,
      one-shots, voice, the 250 ms rest, menus, hidden page, unlock and
      hint, voice holding auto-forward, warm-up, the `#audio` hook, and
      `audio` in kinetic.mjs's `current()`; a WebKit driver option that
      requires a gesture for audio; the Windows app's autoplay flag.
      Tests:
      - Vitest for the volume product, the one-shot pool (steal oldest,
        `channel` cuts) and the rest timer.
      - `audio.scenario.mjs` on fixtures/audio-demo, in Chrome and
        WebKit:
        - Space, the wheel, `e`, `u`, a bookmark, a reload and skip each
          land on the item's resolved target, read through the hook;
        - one-shots fire only on `read` arrivals;
        - the join's music follows the route read last;
        - after a reload nothing plays before a gesture, the hint shows,
          and one key unlocks it (in WebKit with the gesture option);
        - a hidden page pauses and a shown one resumes;
        - the Esc screen pauses every element, and closing it resumes
          them;
        - music and ambience play on under the branch map;
        - auto-forward waits for a long voice line only while it is
          audible;
      - fixtures/demo creates no audio element.
      - The Windows app's Go tests: the environment is created with the
        autoplay flag; `GOOS=windows go vet` is clean.
      (2026-11-10: the branch was rebased onto Phase 46 and renumbered
      first; items 1-4 re-checked after it: full pytest 809, npm test
      1057, self-test 21 cases, check-game on the audio demo clean in
      Chrome and WebKit. render/audiorules.ts holds the pure rules
      (volume product, `maySound` for menus, hidden page and the pop-out,
      `playPlan`, the pool, the director with `REST_MS` 250);
      render/audio.ts `mountAudio` returns null without audio, else
      `setScreens`, `setSettings`, `setVolumesOpen` (item 7) and a
      `video` channel item 6 loads. Settings `soundOn`, `musicVolume`,
      `effectsVolume`, `voiceVolume`, no UI yet. The machine's
      `setVoiceAudible` holds auto-forward for the voice line. Unlock,
      measured: Chrome refuses until a key, then allows any element;
      WebKit with `.audio` required allows an element made or started
      inside the key's handler, refuses one first played seconds later,
      and lets a volume-0 element play with no gesture, then pauses it as
      its volume rises, so a play asks at 0.001 until a key counts. Esc
      and Cmd/Ctrl/Alt shortcuts make the elements but do not unlock.
      The hint is a top-right pill that moves nothing. Windows sets
      `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, keeping the reader's own
      arguments; not run on Windows. The WebKit driver gains
      `--require-gesture-for-audio` and a visibility request; Chrome's
      hidden page is a cover tab. `current().audio` reports `unlocked`,
      `target` and the live elements. Faults injected and caught: the
      pool stealing the newest, no channel cut, a 0 ms rest, a 0 voice
      hold, music under Esc, no elements made in the key's handler.
      Orchestrator: npm test 1102, check clean, Go tests and windows vet
      clean, smoke 6/6, Chrome `audio screens menus media navigation
      checkgame` 206/206, WebKit `audio menus media navigation` 101/101.
      Not verified: WebView2 on Windows, real Safari, Firefox, listening.)
- [x] Silent automated runs (item 12, added 2026-11-10; user report:
      the scenarios played the demo's tones aloud): every browser the
      tools launch, Chrome and the WebKit driver, makes no sound, while
      playback, `current().audio` and the gesture rule work as before.
      Tests:
      - probes on digitally silent files: no Core Audio output opened, or
        muted where that cannot be had, in both engines;
      - the Vitest and `node --test` checks of the launch options;
      - `npm run verify -- audio` on Chrome and WebKit, run only after
        the user says continue;
      - the scenario files of every changed launcher.
      (2026-11-10: Chrome starts only through core.mjs `launchChrome`, which adds
      `--disable-audio-output`, a fake output stream; puppeteer's own
      `--mute-audio` was measured still opening a Core Audio output and
      playing zeros. biome.json rejects a `puppeteer-core` import outside
      core.mjs. WKWebView has no fake output, so the test driver mutes
      its page (`_setPageMuted:`, read back through `_mediaMutedState`;
      puppet.mjs refuses a driver that does not report it); its output
      still runs, playing zeros. The Mac and Windows apps are unchanged.
      Signal: Core Audio's per-process objects polled every 50 ms, with
      coreaudiod's `pmset -g assertions` as a cross-check; positive
      control Chrome without the flag and the unmuted driver, negative
      control a page with no media. Silent probes: media advances in real
      time, `playing`, `timeupdate` and `ended` fire, and play() before a
      key is refused in Chrome and in the driver with
      `--require-gesture-for-audio`. Found on the way: headless Chrome
      played the macOS alert sound for each key the page left unhandled
      when CDP sent it with `nativeVirtualKeyCode` (about 40 alerts from
      test runs in the 3 hours before, and 4 more from this item's first
      probes); core.mjs now sends the native code for Escape alone.
      bookmark-timing's Safari mode cannot be silenced through WebDriver
      and says so. npm test 1107 (5 red first). Orchestrator: npm test
      1107, check clean, the probe through `launchBrowser` shows no Core
      Audio output where the stock launch shows one, smoke 6/6, Chrome
      `screens menus media checkgame bookmarkmap window` 200/200, WebKit
      `menus media screens` 120 pass and 2 known fullscreen partials.
      After the user's continue: `npm run verify -- audio` 44/44 on
      Chrome, with no process starting Core Audio output during the run,
      and 44/44 on WebKit.)
- [x] Player: video sound (item 6): it plays only while the video plays,
      syncs at range and native loop wraps, re-seeks past 80 ms, pauses
      with the video, and ducks. Tests (scenario parts on the audio
      demo's video, in Chrome and WebKit):
      - silent on posters, playing while the video plays;
      - within 80 ms of the video across three range wraps and after a
        seek;
      - playing on under the text chain;
      - the duck applied and lifted;
      - paused under the Esc screen.
      (2026-11-10: visual.ts `watchVideo` reports the stage's video and
      whether it plays or shows its poster; main.ts hands it to
      `audio.setVideo`, which loads the track into the `video` channel.
      The sound runs between the video's `playing` and its `pause` or
      `waiting`. The pure `stepVideoSync` (audiorules.ts) starts every
      play with a seek to the video's time plus a lead learnt per kind of
      seek (a wrap start, a resume, a seek while playing), each from its
      own landings, capped at `VIDEO_LEAD_MAX_S` 0.75 s; while it plays,
      an animation-frame check re-seeks when the video's time moves back
      (a wrap) or the sound is more than `VIDEO_SYNC_S` 80 ms off, judged
      `VIDEO_LAND_MS` 900 ms after the last `seeked`. Measured: Chrome
      lands a seek 64-86 ms behind, WebKit 340-575 ms behind by kind, so
      plain re-seeks never converge there. WebKit bug handled: an element
      paused near its file's end, or played to the end, then sought and
      played ends at once and shrinks `duration`; such an `ended`
      reloads it. `duckFor` fades music and ambience to the duck over
      250 ms and back. The menu checks ask that each element holds still
      while paused and lands in step after resume, since every resume
      seeks to the video's time. Drift once landed: Chrome -5 to +13 ms,
      WebKit -77 to +63 ms. The first version failed WebKit 3 runs in 4
      (one lead shared by kinds that land differently); fixed. 22 new
      Vitest tests, red first; a sync bound of 10 s or a duck of 1 turned
      10 Vitest and 6 Chrome checks red, one shared lead 6. The demo's
      range ends at the file's end, so the scenario wraps by `ended`;
      mid-file range ends and native loops are covered by Vitest only.
      Orchestrator: npm test 1129, check clean, smoke 6/6, WebKit
      `videosound` 19/19 five runs in a row, WebKit `videosound audio
      media videofit` 107/107, Chrome `videosound audio media screens
      videofit` 196/196. Not verified: listening, real Safari, unmuted
      WebKit output, Windows, Firefox.)
- [x] Player: sound controls and the Esc screen (item 7): `soundOn` and
      the three volumes, saved and exported; `v` with its pill; the Keys
      row, the Sound row and the Volumes pop-out, only when the manifest
      has audio; the rebalanced layout. Tests (screens scenario parts for
      both fixtures):
      - the existing layout checks pass for each;
      - widths within 1 px and natural heights within 20 px at
        1920x1080, 1280x720 and 800x600;
      - no scroll at 1280x720, 700x900 and 800x600, with Reset in view;
      - the pop-out opens, works from the keyboard, and Esc closes only
        it;
      - a volume change shows on the hook element's `volume` and
        survives a reload;
      - music and ambience play while the pop-out is open and pause
        again when it closes;
      - an Effects or Voice change plays a sample of at most 2 s;
      - `v` and its pill;
      - fixtures/demo shows neither row, and `v` does nothing there.
      (2026-11-10: with audio only, `v` turns sound on or off with a
      "Sound on"/"Sound off" pill, works over the story, a choice, the map
      (no pill there) and the Esc screen, and is held by the reset box and
      the sheet; the Keys card gains "Sound on / off" after H; Play all
      routes' card gains a second row, "Sound", a "Volumes..." button and
      the switch. render/volumes.ts is the sheet, made like the reset
      box: focus to Music on open, Tab kept inside, focus back to the
      button on close, Escape, Done or a click outside close it alone.
      Volumes step in tenths (`stepVolume`), read as percentages, are
      heard at once and saved straight away without `machine.setSettings`
      (an auto-forward hold is not restarted). A `sample` slot in audio.ts
      plays at most 2 s (`SAMPLE_MS`) of the last one-shot or the current
      voice, else the game's first. Balance, Keys against Settings,
      natural heights before -> after (demo / audio demo): 1920x1080
      2 -> 2 / 9, 1280x720 10 -> 10 / 18, 800x600 3 -> 3 / 5, 700x900
      14 -> 14 / 8 px; widths equal; no scroll at 1280x720, 700x900 and
      800x600, Reset ends at 462 of 600. A Sound card of its own would
      have made 1280x720 about 33 px. 22 Vitest tests and 8 scenario
      checks red first; 4 unit and 5 scenario faults turned 9 tests and 9
      checks red (the no-save fault first passed through the unload
      flush, so the checks now read the stored record). Orchestrator:
      npm test 1148, check clean, smoke 6/6, Chrome `screens audio
      videosound menus` 193/193 and `window progress creator reading`
      86/86, WebKit `screens audio menus` 172 pass and 2 known fullscreen
      partials; screenshots of the Esc screen and the sheet at 1280x720
      looked balanced. Not verified: listening, real Safari, Windows.)
- [x] kinetic-extract reads Ren'Py audio (item 8): the statements,
      channels, names and specs it lists, mapped to music, ambience,
      one-shots and voice on the next item; the unconverted cases
      reported; the `voice` and menu faults fixed. Tests:
      - a synthetic `.rpy` case for each statement and mapping;
      - the `voice` and menu regressions, red before the fix;
      - a report line for each unconverted form.
      (2026-11-10: converter/kinetic_extract/audio_statements.py reads
      the statements, audio_cues.py maps them; `ItemRecord.audio` is
      already the item `audio` shape with track ids, and
      `TimelineResult.audio_tracks` holds one track per distinct file,
      start, loop start, volume and loop, its id from the file's base
      name. The manifest carries no audio until item 9 ships the files
      and measures durations; the ledger shows the cues (item `audio`,
      `audioTracks`) and the summary counts them. Rules read from the
      Ren'Py 8.3 sources: music loops, sound and voice do not, `audio`
      one-shots overlap on fresh sub-channels, a registered channel loops
      unless `loop=False`, `loop=None` loops up to 8.3 and not from 8.4
      (`renpy/vc_version.py`); automatic names lowercase every audio
      file's base name under game/audio/, a define winning; lookup game/
      then game/audio/. Judgement calls: `fadeMs` only from a fade clause
      (the longest); a cue before a menu goes to every route's first
      item; a missing file drops its cue on any channel; `renpy.play`
      and `play movie` are reported; registered creator statements now
      match before dialogue (`sfx "boom"` was dialogue); volumes above 1
      are clamped and reported. 34 new tests; the voice and menu
      regressions red on a copy of HEAD; 10 deliberate breaks each
      caught. A 12-game corpus sample, read-only: 14,032 statements read,
      8,869 items with cues, 8,958 reported (3,430 in skipped blocks,
      2,127 in menus rejected for other reasons, 1,943 missing voice
      files), no crash; two parser bugs it found fixed with tests (a
      playlist over several lines, a file named `loop`). Seen in passing,
      not fixed: `AssetArchives.candidates` scans every archive key per
      image fallback lookup, minutes on an archive-heavy game.
      Orchestrator: the new test files 34 passed, full pytest 843, the
      renpy_demo golden unchanged, no game names or paths in the new
      text.)
- [x] kinetic-extract ships the sound (item 9): audio through the
      `audio` kind, tracks with measured durations, and audible video
      soundtracks as `videoSound`. fixtures/renpy_demo gains the cases
      the plan lists. Tests:
      - the renpy_demo golden;
      - converting twice gives identical folders;
      - `rebuild` reproduces the audio;
      - the converted folder validates and plays its sound in
        `check-game.mjs` (read through the hook).
      (2026-11-10: converter/kinetic_extract/audio_ship.py runs a second
      asset pass after the item pass: one `audio` record per distinct
      source a kept item names, loose or from `.rpa`, through the decoder
      hooks, plus each kept video item's file. Each shipped track becomes
      `audio.tracks.<id>` with `file` and the decoded `durationSeconds`;
      a track that fails drops its cues as a missing file does; a start
      at or past the end drops the track, a loop point past it gives
      `loop: false`. An audible soundtrack lasting to the range end
      within 0.05 s becomes `videoSound: {track}`; silent, absent, failed
      and too short ones are counted. When no track ships, no item keeps
      `audio` (a corpus game that only stops music failed validation
      without this). Episodes carry `project` on track sources so their
      audio rebuilds. fixtures/renpy_demo gains a music track by its
      automatic name, a Vorbis ambience loop on a registered channel, a
      one-shot, a voice line, a choice block with `stop` and a
      `<from 0.5 loop 1.0>` play, and a movie with an MP3 soundtrack,
      formats whose shipped bytes do not depend on the ffmpeg version;
      the golden gains 6 tracks and audio on 5 items, and the decision
      id moved to `menu-start-47`. 11 new tests and the changed ones red
      against HEAD; 7 deliberate breaks caught. Corpus, read-only, three
      games: 8 tracks (7 Ogg remuxed), 0, and 1 extract with 1 audible
      and 6 silent soundtracks; one walked in Chrome, 409 of 409 items.
      Their remaining validation problems, text items before the first
      picture, are the same with HEAD's converter. Seen, not fixed: an
      MP3 extract keeps the encoder delay, about 50 ms at 22 kHz, under
      the 80 ms re-seek bound. Orchestrator: full pytest 854; a fresh
      kinetic-extract of fixtures/renpy_demo validates, prints `audio: 5
      items carry sound; 6 tracks shipped (5 copy, 1 extract), 0
      dropped` and `video soundtracks: 1 audible, 0 silent, 1 absent`,
      rebuilds 15 of 15, converts byte-identical twice, and walks 20 of
      20 items clean in Chrome and WebKit.)
- [x] Docs (item 10): README, docs/stack.md, docs/packaging.md, CREATE.md,
      docs/verify-player.md (scenario rows and the listening checklist),
      AGENTS.md, apps/README.md, and docs/perf.md, with navigation p95
      with audio measured on both manifests.
      (2026-11-10: README gains sound under Content, `v`, the Sound row
      and Volumes box, the unlock hint, the apps and the audio demo, and
      "Audio" leaves Not supported; docs/stack.md an "Audio decision"
      section; docs/packaging.md audio in `media/` with sizes; CREATE.md
      a "Sound" subsection, the `audio` kind's results, `videoSound`
      after a remux, "Checking the sound" and `current().audio`;
      docs/verify-player.md rows for `audio` and `videosound`, the sound
      parts of `screens`, and a 49-step listening checklist for item 11;
      AGENTS.md the builders, perf commands and the gesture option;
      apps/README.md "Sound at launch". perf.mjs counted every second
      Space, a leftover from before one press made one step; it now
      counts every press and takes a folder and `--start ID`;
      soundperf.mjs `--folder DIR` writes item 4's story as a game.
      Navigation p95, headless Chrome, three runs: fixtures/demo
      33.0-36.3 ms, the audio demo 33.2-35.0, the 160,000-item story
      with audio 34.1-34.9 from item 0 and 33.8-34.7 deep, without
      audio 34.1-34.6 and 34.2-34.9, all under 41 ms; WebKit not
      measured (perf.mjs drives Chrome). Corrected on the way: the
      self-test case count (21) and the bundle size (about 415 KB). The
      160,000-item measurement crashed the player in Chrome; that fix is
      item 13. Orchestrator: npm test 1150, check clean, smoke 6/6,
      Chrome `audio` 56/56; the checklist read through and matches the
      demo's items.)
- [x] No argument spread over a story-sized list (item 13, added
      2026-11-10; found measuring item 10): `Math.max(...list)` and the
      like throw in Chrome past about 120,000 arguments, so a
      160,000-item game never answered a key (render/audio.ts, its
      ambience cap), and storage/ids.ts does the same over the seen set
      when a saved place no longer exists. Tests:
      - a Vitest case per fixed site with 200,000 entries, red first;
      - a sweep of player/src for spreads into calls over story-sized
        lists, each fixed or shown bounded.
      (2026-11-10: fixed render/audio.ts's ambience cap
      (`largestAmbienceSet`, a loop), storage/ids.ts's fallback when a
      saved place no longer exists (the sorted seen list's last entry,
      the list `visited` already returns), machine.ts `showScreen`'s
      `stack.push(...framesAround())` (a loop; frames bounded only by the
      decision count), and branchmap.ts's bookmark cards (a
      DocumentFragment; bookmarks have no cap). Red first: the ids.ts
      case with 200,000 seen ids threw RangeError (Node throws from about
      125,000 arguments), and the audio.ts case with 160,000 items failed
      with the spread swapped back. Left, bounded: visual.ts:244 (one
      animation's frames), mapmodel.ts:2070-2071 (at most 2 edges),
      choice.ts:461 (one decision's routes), config.ts:316 (a fixed few
      children); player/scripts/testing has none. Orchestrator: npm test
      1151, check clean, smoke 6/6, the sweep re-run over player/src and
      player/scripts/testing lists only those four, Chrome `bookmarkmap
      branchmap navigation branches audio` 235/235.)
- [x] Ambience loops play on (item 14, added 2026-11-10; user, listening
      check: on `amb-start` the rain stopped after one play and the hum
      restarted with gaps; `amb-carry` had no rain). Tests:
      - the audio scenario, Chrome and WebKit: rain and hum still play
        after three times their length, their clocks advancing with no
        pause at a wrap beyond one frame; the same for a music loop and
        for `steps`' loop from 3 s;
      - a Vitest case for the root cause, red first.
      (2026-11-10: the player made no play, pause or seek on the loops;
      the engines' own wrap of one element was at fault, as a bare
      `<audio loop>` page showed. WebKit stopped the rain for good at
      6.0135 s after its second pass and stuck the hum at 0.0001 s after
      a few wraps, losing about 0.44 s per WAV wrap before that (an
      analyser found real silences of 152 and 345 ms); its seek-on-end
      path lost 124-569 ms a wrap. Headless Chrome's own loop lost 85-101
      ms a wrap, its seek-on-end 79-87 ms. Fix: every music and ambience
      channel has two elements that trade places at each wrap; the
      waiting one sits paused at the restart point, starts at volume
      0.001 a lead before the end (learnt per file from settled starts,
      after a first rehearsal, since WebKit starts a file's first play
      faster), and takes over at the end, both moments timed from the
      animation frame before them; frames run only near a loop's end. The
      end is the track's length or the file's, whichever is first (WebKit
      gives calm.m4a 7.977 s). No element `loop`, no seek of a playing
      element. The spares are started inside the unlocking key's handler
      with the rest. 6 Vitest cases and 3 scenario parts red on the old
      code; wraps now within 16 ms in Chrome (one frame) and 59 ms in
      WebKit (one frame plus the muted driver's 85.3 ms start grid).
      Not known: the real output grid in Safari and the Mac app; WebKit
      hitches its main thread 40-100 ms when an element pauses or ends.
      Orchestrator: npm test 1155, check clean, smoke 6/6, Chrome `audio
      videosound screens` 189/189, WebKit `audio videosound` 82/82, and
      in WebKit with `requireGestureForAudio` and a Space unlock on
      `amb-start` rain and hum played 26 s, through 4 and 6 wraps, with
      no time lost. The user re-listens with item 15.)
      (Reopened 2026-11-11: the user re-listened in Safari, Chrome and the
      Mac app; rain and hum no longer stop but leave a gap at every wrap
      in all three. Item 15 the same day: the click at each video restart
      (the left wall) is quieter or cut short in Chrome and sometimes
      missing in Safari and the app. The muted and fake-output test
      engines did not show either.)
      (Closed 2026-11-14 by item 18: loops are buffer sources with
      sample-exact wraps, checked by the tap of the mix in Chrome and
      WebKit. The user re-listened to the rebuilt audio demo in Safari,
      Chrome and the Mac app with item 11: all as described.)
- [x] Video sound clicks stay on the wall hits (item 15, added 2026-11-10;
      user, listening check: usually on the hits, sometimes not). Tests:
      - the videosound scenario, Chrome and WebKit: across ten wraps no
        click is skipped or doubled (mapping the sound's played spans to
        the clock track's click times) and every frame is within the
        sync bound, re-seeks included;
      - a Vitest case for the root cause, red first.
      (2026-11-11, box left open until the user re-listens: at each wrap
      the player paused the sound, sought the same element to the
      restart point plus a lead and played it; the click at the restart
      point fell inside the lead and was skipped every wrap, and drift
      re-seeks jumped clicks too. Before, over about 20 wraps, the text
      chain, Esc and the map: Chrome 21 of 79 clicks skipped, WebKit 25
      of 76, WebKit with the key rule 24 of 77, none doubled. Fix: the
      video channel trades two elements like item 14's loops, the spare
      cued at the restart point (`videoCue`), so the playing element is
      never sought; the lead is learnt only from starts heard at full
      volume (a rehearsal at volume 0.001 runs WebKit's clock about 60
      ms in without its sound, which taught a wrong lead and left a wrap
      stuck 315 ms); no start soon after a seek of its element; WebKit
      begins every sound on an output block (85.33 ms in the muted
      driver), detected from the starts (`startGrid`, none assumed), so
      starts are timed to the nearest block end; a start from paused or
      a menu resume makes the video wait for its sound (about 0.3 s in
      WebKit, 25 ms in Chrome; `setStartDelay` in visual.ts). The
      scenario's ten-wrap window starts after the first wrap. 19 tests
      of the deleted seek-per-wrap rules replaced by 10; the old code
      skipped all 10 wrap clicks in the Vitest model and failed the new
      scenario checks in both engines. Orchestrator: npm test 1147,
      check clean, smoke 6/6, Chrome `videosound audio media videofit
      screens` 233/233, WebKit `videosound audio media videofit`
      126/126, WebKit `videosound` alone 19/19 in 3 runs of 4; the
      fourth, at load average 6-10, had one wrap 113 ms ahead (2 clicks
      off, none skipped or doubled) and the text-chain check failed with
      it.)
      (Closed 2026-11-14 by item 19 and its follow-up: the sound is a
      buffer loop on the audio clock and the video follows it; the tap
      maps every click to its wall hit in Chrome and WebKit, under load
      too. The user re-listened in Safari, Chrome and the Mac app with
      item 11: every wall hit clicks, all as described.)
- [x] A trial of two sound routes (item 16, added 2026-11-11; the user
      chose a trial before fixing items 14 and 15 again): scratch pages
      for Web Audio from script-held bytes and for the video's own
      soundtrack with crossfaded element loops, measured from their
      samples in Chrome and WebKit, decode support per format, and the
      user's listening in Safari and Chrome. Done when the user picks a
      route.
      (2026-11-11: scratch pages in .tmp/trial16, every recording
      through a zero gain. Under file:// in Chrome fetch and XHR fail and
      a media-element source outputs zeros; bytes loaded by a script tag
      decode. Buffer loops bit-exact in Chrome, WebKit and WebKit with
      the key rule (rain 15 wraps, hum 23, calm 11, steps 10).
      `decodeAudioData` against the lossless source: AAC, WAV, FLAC and
      Opus in Ogg exact at the start in both, Vorbis in WebM +64 at the
      end; MP3 +576 at the start in WebKit, Opus in WebM -24 in Chrome,
      Vorbis in Ogg -128 in WebKit. Video clicks, sound minus picture:
      Web Audio -24 to +26 ms in Chrome, -29 to +48 in WebKit, all 56 at
      full level; the video's own sound never cut, but picture and sound
      pause 27-50 ms at each range wrap; crossfaded element loops came
      100-125 ms early in Chrome and left 170-450 ms silences in WebKit.
      The user listened in Safari and Chrome and chose Web Audio; items
      17-20 carry it out.)
- [x] Audio files ship as scripts (item 17): `<file>.js` beside each
      audio file, written by kinetic-media, kinetic-extract, the demo
      builder and assemble_folder; loop-safe formats for looping tracks.
      Tests:
      - the script's bytes equal the audio file's, twice-built folders
        identical, `rebuild` matching the scripts;
      - a looping MP3, Opus WebM or Vorbis Ogg source shipped in a
        loop-safe format, with the new self-test golden;
      - the validator: a missing script is an error, a looping track in
        an unsafe format a warning;
      - the renpy_demo golden and the audio demo rebuilt.
      (2026-11-13: converter/kinetic_extract/audio_format.py writes
      `__kineticAudio("<file as the manifest names it>","<base64>");`,
      one ASCII line depending only on path and bytes; kinetic-media and
      kinetic-extract write it beside each audio output, the ledger
      records `script: {sha256, bytes}`, `rebuild` remakes and checks it
      (older ledgers still rebuild), assemble_folder and the demo builder
      write missing ones, and CREATE.md gives a shell loop that writes
      the same bytes. A kinetic-media `audio` request takes `loops`; a
      looping file that would ship as MP3 or Opus in WebM is re-encoded
      to AAC in M4A at 192 kb/s (starts exactly in both engines, plays in
      every Safari and both app hosts, the pinned ffmpeg's own encoder);
      Vorbis in Ogg is still remuxed into WebM; kinetic-extract marks
      music (unless `loop: false`), ambience and video sounds as looping.
      The validator errors on a missing or mismatched script and warns on
      a looping track in MP3, Opus in WebM or Vorbis in Ogg. The audio
      demo's rain is FLAC and bright and cold AAC; renpy_demo's theme and
      movie sound ship as AAC, so its golden compares those tracks by
      format (AAC bytes depend on the ffmpeg version). New self-test case
      `ffmpeg.audio-loop-aac`, repinned by the orchestrator from the
      installed pinned tools: d4c3ca0c8179f6662de27d0ae92b9b8ca34e6f4610
      ceeda5e464f23fa0b17ad7, every other case matching (22 cases pass).
      Red first in 6 test files. Orchestrator: full pytest 921; a real
      kinetic-extract of fixtures/renpy_demo prints 3 copy, 1 extract, 2
      transcode, validates, rebuilds 15 of 15, converts byte-identical
      twice, and each script decodes to its file's bytes; the audio demo
      validates; npm test 1147, check clean, Chrome `audio videosound
      screens` 189/189, WebKit `audio videosound` 81/82, the miss being
      item 15's known video-sound wrap check, which item 19 replaces.)
- [x] Player: sound on Web Audio (item 18): one AudioContext unlocked by
      the first key, tracks loaded from their scripts and decoded under a
      byte cap, buffer-source loops, gain AudioParams, every pause rule,
      the hook unchanged in shape, silent automated runs. Tests:
      - the existing audio, videosound and screens scenarios pass in
        Chrome and WebKit;
      - item 14's loops play with no gap, read from a test-only tap of
        the mix, in both engines;
      - Vitest for the decode cache and its cap.
      (2026-11-13: music, ambience, one-shots, voice and the Volumes
      sample play as buffer sources through a sound gain, a group gain
      (Music then the duck, Effects, Voice), the mix and the master;
      `gainStages` splits `elementVolume` over them, and fades and the
      duck are ramps in context time. Loops use the source's `loop` with
      `loopStart`/`loopEnd` from `playPlan`, snapped to whole samples.
      Tracks load through `__kineticAudio` and a script tag, decode once
      per file (a failure is logged, not retried) and stay in
      render/audiocache.ts's LRU under `DECODED_CAP_BYTES` (200 MiB: a
      3-minute stereo AAC decodes to 69.1 MB, in 209 ms in headless
      Chrome and 3,670 ms in the WebKit driver, so three such tracks
      stay); held buffers are never dropped; the warm-up decodes every
      track of the next 3 items, at most 8 files. A pause stops each
      held source at its `playPosition` and restarts it there. Unlock:
      Chrome's context starts suspended and nothing starts before a key
      that counts; the stock driver's starts running 10-130 ms after it
      is made; the hint waits 500 ms (`HINT_GRACE_MS`) so the Mac app
      does not flash it. Silence: testing/testaudio.mjs's flag reaches
      every page from `launchChrome` (each context's `newPage`) and
      `launchWebKit` (`addScript`), and the player holds the master at 0
      under it; a muted driver page playing zeros opened a Core Audio
      output, so the page mute alone is not shown to silence Web Audio.
      The tap (scenarios/soundtap.mjs, an AudioWorklet from a data: URL
      on the mix before the master) matches every frame to the tracks
      looped: max error 1.5e-8 in Chrome, 0 in WebKit with and without
      the key rule, over three or more wraps of rain, hum, calm and
      steps; HEAD's element trade, served over http through a
      media-element source, scored 0.39 and 0.73 with about 90% of
      frames wrong. The menus, hidden-page and voice-under-map checks now
      also check where a sound resumes. Item 14's element trade, lead
      learning, rehearsal and output-grid timing are gone for music and
      ambience; the video channel keeps item 15's until item 19. Red
      first: 15 unit tests plus 3 launcher and reader tests; 7 scenario
      checks and 6 unit tests red under deliberate breaks. Not covered: a
      long track not warmed up starts about 3.7 s late in WebKit after a
      jump (decode time). Orchestrator: npm test 1163, check clean,
      smoke 6/6, Chrome `audio videosound screens menus` 200/200, WebKit
      `audio videosound screens` 194/196 in two runs in a row (the 2
      known fullscreen partials), check-game on the assembled audio demo
      exit 0 in Chrome and WebKit, 35 of 35 items, no errors; AGENTS.md
      names the test sound flag.)
- [x] Player: a video's sound on the audio clock (item 19): the sound's
      buffer loops the video's range and the video follows it. Tests:
      - item 15's checks from the tap, in Chrome and WebKit, five WebKit
        runs in a row.
      (2026-11-13: the video sound is a buffer `Sound` in slot `video`
      through the Effects gain, looping from the restart point to the
      range end (`videoSoundPlan`, snapped to samples); the <audio>
      channel and all of item 15's element rules (`videoCue`,
      `startGrid`, lead learning, rehearsal) are gone. The video follows:
      `StageVideo.restart()` (visual.ts) is called one seek lead before
      each wrap, the lead learnt from the restart frames
      (`learnSeekLead`); drift is judged per presented frame
      (`requestVideoFrameCallback`) on the median of the last 3 against
      the sound heard as it shows (output clock from
      `getOutputTimestamp`), with a seek past 80 ms; a seek the player
      did not cause moves the sound to the video (`seekMovesSound`); a
      pause resumes the sound where it stopped; before unlock the video
      runs on its own clock and the unlocking key starts the sound where
      the video is. Assembled folders ship only the scripts:
      assemble_folder leaves out each track file whose script is there
      (unless an item shows it), the validator accepts a script alone
      and reads codec warnings from its bytes, a track with neither is
      an error; content folders keep both. The videosound scenario reads
      clicks from the tap (`findClicks`, the 2,500 Hz burst), frames from
      rVFC and the sound's timeline from the engine; clicks where the
      video showed no frames, or hidden by a tap gap, are counted and not
      judged, the timeline must stay unbroken. A Chrome flake under load
      (a stray click) was the checker's: the video never presented its
      restart frame, so the wrap's click had no hit; fixed with five
      other checker faults and two player weaknesses found under load (a
      late own-seek event replaying the sound, a drift left at 83 ms by a
      "3 frames in a row" rule). Clicks against wall frames: Chrome -18
      to +19 ms, WebKit -7 to +22, with the key rule -4 to +23. HEAD's
      element trade through the tap: WebKit 13 of 40 hits skipped and 23
      off, Chrome failing chain, menus and drift. Red first in Vitest
      and 10 Python tests. Orchestrator: npm test 1168 (three runs),
      check clean, full pytest 931, smoke 6/6; deliberate breaks on the
      final code (loopStart 0.5 s early, no pre-wrap seek, resume from
      0, no drift seeks) each failing their checks; Chrome `videosound
      audio media videofit screens menus` 244/244, WebKit `videosound
      audio media videofit` 143/143, WebKit `videosound` 29/29 in five
      runs in a row; the assembled audio demo 45 files, 2.8 MiB, no
      audio file left, validator clean, check-game exit 0 in Chrome and
      WebKit with 35 of 35 items.)
- [x] The videosound checks hold under load (item 19 follow-up, added
      2026-11-13): in a Chrome run at load average 13 the seek check
      failed, Chrome's video presenting its restart frame 230 ms late
      (that click 122 ms off) and then no frame for 800 ms (frames up to
      749 ms behind the sound). Find whether the player can recover
      faster or the checker judges what the browser never showed, fix
      the cause, and keep every guarantee. Done when Chrome and WebKit
      `videosound` pass under the load of the full suite.
      (2026-11-13, four rounds under busy loops at load average 13-120.
      Player: after a seek lands or 150 ms pass with no presented frame
      (`VIDEO_FRAME_GAP_MS`) the frames are judged afresh and a video
      still past the bound is sought at once (`shownAfter`); the frame
      bound is 80 ms less a vsync of jitter (`VIDEO_FRAME_JITTER_S`); the
      learnt seek lead grows 10 ms a restart at most (`SEEK_LEARN_UP_S`);
      a seek the player made is never judged as a jump when its event
      comes late (`seekMovesSound`); a resume keeps the sound where it
      stopped and seeks the video onto it (`videoResumeTarget`; before,
      a video paused 82-113 ms off moved the sound back about 85 ms under
      the map, the Esc screen and a hidden page); the restart timer arms
      from any frame within 300 ms of its moment
      (`VIDEO_RESTART_ARM_MS`); WebKit sometimes runs a sought video with
      no `playing` event, so whether the stage video runs is read from
      the element on every event (`stageRunsAfter`; the video sound
      never joined after the key in 1 run of 20). Checker: `findClicks`
      holds only after an accepted click; a click where the video showed
      no frame is counted (`unseen`), not judged; a tap gap excuses only
      a hit with no click; the first 4 frames after a seek that took over
      60 ms to land, a 150 ms presentation gap or a restart timer the
      hook (`restarts()`) says ran over 30 ms late are counted
      (`recovering`) and not judged, measured back in step within 1-2
      frames in 25 of 26 recoveries; a frame read over 100 ms after it
      showed is not judged; the seek check asks that the video stays
      where it was sent with its sound within 80 ms. Red first in Vitest
      for each player change. Orchestrator, on the final code with the
      next entry's gate: deliberate breaks (loopStart 0.5 s early, no
      pre-wrap seek, resume from 0, a seek leaving the sound, no drift
      seeks) each failing their checks; npm test 1216 (two runs), check
      clean; full Chrome `npm run verify` 585/585 at load average 35;
      WebKit `videosound audio screens media videofit menus` 261/263
      (the 2 known fullscreen partials); WebKit `videosound` 31/31 in
      three runs; Chrome `videosound` 21/21 twice with eight busy loops
      at load 21-40; the assembled audio demo validating, check-game
      exit 0 in Chrome and WebKit with 35 of 35 items.)
- [x] In a browser nothing plays before a key, whatever the engine allows
      (item 5's rule, added 2026-11-13): the WebKit driver with the key
      rule sometimes ran the first page's AudioContext a few hundred ms
      after load with no key, no `resume()` and no source started (4 of
      12 runs, four drivers launching at once), so the player, which
      plays as soon as its context runs, sounded before the key. The
      player starts no sound in a browser before a key or click that
      counts; a game app (its host bridge present) plays at launch as
      now. Done when the videosound unlock part passes with Escape
      closing the help screen and the sound silent until the key, in
      WebKit and Chrome, and the audio scenario's unlock checks pass.
      (2026-11-13: audiorules.ts `gestureCounts` (a click, a touch, any
      key but Esc and a Cmd/Ctrl/Alt shortcut) and `soundUnlock`:
      `mayPlay` once a counting gesture came or in an app, `mayStart`
      once a gesture came or in an app whose context runs, the hint in a
      browser from load until the gesture whenever sound is on. An app is
      `readHost(window.kineticHost) !== null` at mount: the Mac app's
      document-start user script and the Windows exe's document-creation
      script define it before any page script. The context is still made
      at mount, so decoding ahead goes on; `data-unlocked` and
      `current().audio.unlocked` mean "may play". The unlock part runs in
      Chrome, the stock driver and the key rule, Escape closing the help
      screen, and checks silence by the hook and the tap (13,000-15,600
      tapped frames all zero before the key in WebKit runs whose context
      ran early); the audio scenario's autoplay check opens with the Mac
      app's real host bridge. Red first: 3 Vitest cases. Orchestrator:
      with the gate removed the unlock part failed 3 of 4 WebKit key-rule
      runs; the rest as in the entry above.)
- [x] Docs and speed for Web Audio (item 20): stack, packaging, CREATE.md,
      extracting, verify-player, perf (navigation p95, decode time,
      memory).
      (2026-11-14: docs/stack.md's audio decision rewritten for Web Audio
      (why elements failed, why scripts, the costs, loop-safe formats,
      WebKit's AAC decode, the video sound as clock, the browser and app
      unlock); packaging sizes from a fresh assembly (bundle 445 KB, audio
      demo 45 files, 2.94 MB, scripts 2.25 MB); content-format's
      invariants 2 and 16 no longer contradict on a script alone;
      CREATE.md (self-test 22 cases, the unlock, rebuild the converter's
      folder not the assembled copy, a `script mismatch` row),
      extracting.md, README.md, apps/README.md and converter/README.md
      brought in line; the listening checklist changed only where the
      sound changed (steps 1, 8, 12, 36, 48). `tools/validate_content.py`
      `OGG_WARNING` now says Safari plays Ogg from 18.4 (macOS 15.4) and
      WebKit's decode of Vorbis in Ogg loses its first 128 samples, the
      test pinning the whole line (red first, 3 failed). perf.mjs reports
      decoded audio through a test-only page read (`perfaudio.mjs`, 6
      Vitest cases). docs/perf.md, load average 3.5-12: navigation p95
      fixtures/demo 32.8-34.3 ms, audio demo 32.1-34.4, the 160,000-item
      story 33.5-34.7 (audio stripped 33.0-34.2); the audio demo walk
      decodes 15 tracks to 15.8 MB (7.5% of the cap), a 3-minute stereo
      48 kHz AAC 69.1 MB. Orchestrator: npm test 1222, check clean, full
      pytest 931, content-schema.json parses; perf on the audio demo p95
      34.1 ms with 15 files, 15.8 MB decoded; the stack decision read
      against plan.md's Settled list and render/audio*.ts.)
- [x] A measurement of WebKit's decode time (item 21, added 2026-11-13;
      the user chose to measure before picking a fix for long tracks that
      start about 3.7 s late in WebKit after a jump): scratch pages time
      script load, base64 to bytes and `decodeAudioData` in WebKit and
      Chrome by format, sample rate, channels, length and the context's
      rate, check whether the page stalls meanwhile, and try decoding in
      sample-exact pieces. Done when the user has the numbers and picks a
      fix or accepts the limit.
      (2026-11-13: scratch pages in .tmp/item21, browsers only through
      `launchBrowser`, nothing played; a corpus track's first 180 s,
      stereo 48 kHz, cases in shuffled rounds of 5, load average 4.6-17.
      3-minute stereo AAC in M4A, WebKit against Chrome (median ms):
      script load 16 / 17, base64 by `fromBase64` 1 / 1 (by the atob loop
      13 / 9), `decodeAudioData` 3511 / 203. In WebKit AAC is slow only
      when it decodes at the file's own rate (48 kHz file at 48000: 4191;
      at 47999, 48001, 44100 or 96000: 143-202; a 44.1 kHz file at
      44100: 3610), the same for ADTS, Apple's encoder, every bit rate and
      OfflineAudioContext, growing with the square of the length (60 s
      418, 120 s 1875, 180 s 4129); FLAC 235, WAV 60, MP3 250, Opus in
      Ogg 529, Vorbis in WebM 474. No page stall (longest frame gap 19
      ms), but a 10 s clip asked for during a long decode on the same
      context took 3932 against 34 on its own OfflineAudioContext.
      Decoding at twice the context's rate and keeping every second
      sample: 190 ms, the same start and length, at most 2.2e-5 from the
      usual decode. Pieces join exactly for FLAC, ADTS AAC with `-aac_pns
      0` and 3 frames of pre-roll, and Ogg Opus with a page of pre-roll.
      Orchestrator reproduced 3284 against 190 ms in the WebKit driver.
      The user chose the player fix, item 22.)
- [x] Player: fast AAC decodes in WebKit (item 22): AAC decoded at twice
      the context's rate on an OfflineAudioContext with every second
      sample kept, each file on its own OfflineAudioContext, in WebKit
      only. Tests:
      - Vitest for the sample keeping and the choice of decode;
      - in WebKit a 3-minute stereo AAC ready within 0.5 s and a short
        sound during its decode within 0.1 s;
      - item 14's loop checks from the tap in both engines.
      (2026-11-13: render/audioload.ts holds the script reader (moved
      from audio.ts), `isWebKit` (`navigator.vendor === "Apple Computer,
      Inc."`, which Safari, WKWebView, iOS browsers and the driver report;
      the user agent cannot tell the driver from Chrome), `aacRates` (ADTS
      after ID3, or MP4 down to the AudioSpecificConfig, HE-AAC's core
      and doubled rates), `decodePlan`, `keepEvery` and the track
      decoder. In WebKit every file decodes on its own
      OfflineAudioContext, and only an AAC whose own rate is the
      context's decodes at twice it (three times when twice is also one
      of its rates) with every second sample kept: the brief's wider rule
      kept 881,470 samples where the usual decode gives 881,471 for a 48
      kHz file on a 44.1 kHz context, and would fold a higher-rate file's
      top octave, while every other AAC is fast already. The plan's text
      changed to match. Kept buffers have the usual decode's length and
      first sample at lag 0 over 48 and 44.1 kHz, mono and stereo, odd
      and even lengths, M4A and ADTS; they differ by at most 7.9e-3 on
      full-band pink noise, almost all above 15 kHz (101 dB under the
      signal below it). `DECODED_CAP_BYTES` stays 200 MiB (a dropped
      track now costs 0.13-0.33 s to decode again). New `npm run
      perf:decode` (docs/perf.md, AGENTS.md) synthesizes its tracks with
      PATH ffmpeg. 42 Vitest tests, 31 red against the old decode; the
      timing check red on HEAD in WebKit (3217 ms long track, 3096 ms
      clip); breaks (odd samples kept, the wider rule, a shared context)
      fail 16, 4 and 3 tests. Orchestrator: npm test 1210 (two runs),
      check clean, smoke 6/6; `perf:decode` in the WebKit driver: 3-minute
      48 kHz stereo AAC 3211 -> 189 ms, a 10 s clip asked for during it
      3126 -> 13 ms, keeping 11 ms; Chrome unchanged (198, 13 ms); Chrome
      `audio videosound screens menus` 199/200 at load average 13, the
      miss item 19's seek check (Chrome's video presented its restart 230
      ms late and then no frame for 800 ms), passing in 3 Chrome
      `videosound` runs at load 4-5 and taken up as a fix of item 19;
      WebKit `audio videosound screens` 204/206 (the 2 known fullscreen
      partials); navigation p95 on the audio demo 34.6 ms (budget 41);
      check-game on the assembled audio demo exit 0 in Chrome and WebKit,
      35 of 35 items.)
- [x] User: the listening checklist (item 11), on fixtures/audio-demo in
      real Safari, desktop Chrome and a Mac app built for it. The
      orchestrator does not tick this; the user reports, and any finding
      becomes a fix first.
      (2026-11-14, the user's report after the Web Audio items: the
      listening checklist in docs/verify-player.md, run on the audio demo
      assembled from 4f5a7d9 with its Mac app, matched in Safari, Chrome
      and the app: "All as described". Before it, the validator passed
      the folder and check-game showed 35 of 35 items in Chrome and
      WebKit with no errors.)
- [x] Phase-closer (Phase 47): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof.
      (2026-11-14 on 4f5a7d9: full pytest 931 passed in 88 s; full
      `npm run verify` 585/585 on Chrome; `npm run verify -- --webkit`
      600 pass and 5 partial (the headless fullscreen checks), 0 fail;
      package-proof 18/18 with .tmp/extract-demo regenerated from
      fixtures/renpy_demo. Items 11, 14 and 15 closed by the user's
      listening the same day.)

## Phase 48: check-game follow-ups (2026-11-14, converting agent + user)

- [x] Media check: parallel, with progress, skippable (docs/plan.md Phase
      48, item 1). Tests:
      - the same failures as now (a missing and an undecodable picture,
        video and poster) on both engines;
      - the progress line, with its interval shortened;
      - `--no-media-check` says media were not checked and the exit code
        ignores media;
      - measured on a large game: check time before and after on both
        engines.
      (2026-11-14: on Chrome `checkMedia()` opens up to 4 checking pages,
      each in its own browser context on the folder's origin with the
      player stopped, 4 lanes each, taking 8 files at a time from the
      walking page, which logs failures as before; on WebKit the walking
      page checks 8 at a time (more driver processes measured barely
      faster). The page queue no longer shifts and settle() no longer
      lists every open URL on each poll. `onProgress` feeds a stderr line
      every heartbeat interval (`media check: C of T files checked`);
      `--no-media-check` opens with `mediaChecks: false`, says media were
      not checked and leaves the exit to the walk and console. Tests ran
      red first: walk.test.mjs and kinetic.test.mjs units; checkgame parts
      `mediaFailures` (missing and undecodable picture, undecodable video
      and poster each named once, progress lines) and `noMediaCheck`.
      Measured on a sample of a converted corpus game's files: Chrome
      22.4-23.1 -> 1.7-2.1 ms a file (full check ~23 min -> ~2 min),
      WebKit 9.0-9.2 -> 6.5-7.1. Orchestrator: npm test 1228, check clean,
      smoke 6/6, checkgame 20/20 and creator 29/29 on both engines; a
      30,000-step walk of that game, read-only: Chrome exit 0 in 108 s
      with its 10,044 files checked inside 30 s, WebKit exit 0 in 193 s
      with progress lines every 30 s.)
- [x] Media check covers every file a walked item references (item 2).
      Tests: an animation walked past with a broken later frame fails on
      both engines; the summary's counts on the demo.
      (2026-11-14: `checkMedia({ items })` adds every file the shown items
      reference that the page was never given (`referencedFiles`: picture
      or video, poster, every frame, and each audio track's `.js` script,
      checked in its own hidden iframe and decoded on an
      OfflineAudioContext). check-game prints `media: N files: L loaded
      during the walk, C checked after it (R never requested)`, and the
      stderr line before the check says `the walk did not see load`.
      Tests ran red first: walk.test.mjs (`shown()`, the summary line),
      kinetic.test.mjs (`referencedFiles`), checkgame parts `wholeDemo`
      (26 files counted), `brokenFrame` (an undecodable last animation
      frame exits 1, named once) and `audioFiles` (41 files on the audio
      demo; a junk `knock.wav.js` exits 1, named once). A 30,000-step
      walk of a converted corpus game: `media: 10,077 files: 55 loaded
      during the walk, 10,022 checked after it (0 never requested)`, exit
      0. Orchestrator: npm test 1232, check clean, smoke 6/6, checkgame
      24/24 and creator 29/29 on both engines.)
- [x] Failed loads say why (item 3). Tests: a missing and an undecodable
      picture, video and poster on each engine, each named once with its
      reason.
      (2026-11-14: `collectErrors(page, { folder })`, passed by openGame,
      maps the library's line and Chrome's own to one line per URL,
      `[error] Failed to load resource: <url> (<reason>)`, the reason from
      core.mjs `failedLoadReason` on the file behind the URL: `not found`,
      `could not decode`, `not readable`, or `a symbolic link out of the
      folder`; URLs outside the folder or not file:// keep today's wording.
      A WebKit bug found on the way: a failing poster fires `error` at its
      `<video>`, so the tracker blamed the video too; a video error now
      counts only when `video.error` is set. Tests ran red first:
      kinetic.test.mjs (`failedLoadReason` in a folder with a space,
      chmod 000, links in and out; the merge in either order); checkgame
      `mediaFailures` (a missing and an undecodable picture, video and
      poster, each once with its reason, 6 lines) and `audioFiles` (an
      undecodable and a missing script); creator `failedLoads`. Subagent:
      full Chrome verify 594/594; WebKit checkgame+creator failed one check
      in 1 of 12 runs, not captured. Orchestrator: npm test 1236, check
      clean, smoke 6/6, Chrome checkgame+creator 54/54, WebKit 54/54 in 3
      of 3 runs.)
- [x] `--until` implies `--steps all` and reports its span (item 4). Tests
      on demo copies, both engines: a start inside a continuing route (its
      siblings not counted), a main-line start, an item in no route inside
      the span (exit 3, named), `--until` alone walking past 10 steps, an
      explicit `--steps` still limiting it.
      (2026-11-14: readArgs makes `--until` imply `--steps all` unless
      `--steps` is given. walk.mjs `untilSpan` takes the manifest indexes
      from the start to the `--until` item and leaves out the other routes
      of every decision whose route holds the start (nested too); after an
      `--until` stop the summary adds `span: X of Y items shown from A to
      B` and up to ten ids not shown, exit 3 (1 wins). An `--until` before
      the start is walked, and its span line says so. Tests ran red first:
      walk.test.mjs (12: readArgs, the span for main-line, continuing,
      nested, returning and ending starts, lines and exits); checkgame
      parts `untilSpans` (route1-start to after-start 6 of 6 with route 2
      left out; a main-line start past 10 steps, 30 of 30; `--steps 3`
      still exits 1) and `untilSpanGap` (11 of 12, the unreached item
      named, exit 3). A converted corpus game's 20,005-item episode tail
      on WebKit, read-only: `span: 20005 of 20005 items shown`, exit 0, in
      118 s with its media check. Orchestrator: npm test 1248, check
      clean, smoke 6/6, checkgame+creator 58/58 on both engines.)
- [x] Symlinks out of the folder fail (item 5). Tests: both engines, a link
      out of the folder (exit 1, named) and one inside it (passes).
      (2026-11-14: openGame always scans for links resolving outside the
      folder and puts one `[error]` line for the folder first in
      `errors()` on both engines (up to three named, the count, copy or
      hard-link advice; `outsideLinksError`), so check-game exits 1 through
      its normal path and library scripts see it; item 3's per-file
      `(a symbolic link out of the folder)` line appears only where a load
      failed (WebKit). The scan took 632 ms over a converted corpus game's
      113,511 files. Tests ran red first: kinetic.test.mjs; creator
      `symlinkNote` (Chrome red: no line) and a new checkgame `symlinks`
      part (Chrome exited 0 before; a link inside the folder passes).
      Orchestrator: npm test 1249, check clean, smoke 6/6,
      checkgame+creator 61/61 on both engines.)
- [x] Validator reachability warning (item 6). Tests: each gap case warns;
      the demo, the branches example and the audio demo warn nothing; on
      generated manifests the warned items equal the items the machine's
      play-all walk never shows.
      (2026-11-14: validate_content.py `reach_warnings` ports the
      machine's forward flow under play-all (resolveDecisions, moveForward,
      fireDecision, nextAutoRoute, handleRouteEnd, endJoins, join,
      closeIfPureAndComplete, relevantDecision, nothingFollows) and warns,
      on stderr with stdout and the exit code unchanged, on every item that
      walk never shows: "inside decision D (after A, before C) in none of
      its routes", or "no reading from the opening reaches it". 11 Python
      tests ran red first (four gap places, a pure choice's gap, a join
      landing inside another decision's route, unchanged stdout and exit,
      malformed input, and silence on fixtures/demo, the branches example
      and fixtures/audio-demo). player/src/machine/reach.test.ts runs 400
      seeded manifests (14,996 items, 1,883 decisions, every route
      result) through createMachine's play-all walk and the validator:
      the never-shown sets are equal; six injected faults in the port
      each failed it. docs/content-format.md describes the warning.
      Orchestrator: pytest tools/test_validate_content.py 218 passed,
      reach.test.ts passes, tsc clean; on a copy of a converted corpus
      game's 186,268-item manifest (which a full walk showed whole) 0
      warnings in 0.09 s.)
- [x] Docs (item 7).
      (2026-11-14: CREATE.md "The quick check" gains `--no-media-check`,
      `--until` walking as `--steps all` with its span, the older-player
      exit 1 beside `--start-at`, the `span:` and `media:` summary lines
      with real demo output on both engines, and an updated exit table;
      new sections "Checking part of a game", "Items never shown", "The
      media check", "Failed loads" and "Symbolic links out of the
      folder"; the validator's reachability warning under validating; the
      library reference (`mediaChecks`, `checkMedia({ items, onProgress,
      pages })` and its result, failed-load lines); the upgrade guide on a
      seeded `ctx.visited` merging into the seen records and how to start
      clean. AGENTS.md's check-game line updated. docs/content-format.md
      and docs/verify-player.md were updated by items 1-6. Every example
      was run on both engines. Orchestrator: diff ASCII, no game named.)
- [x] Phase-closer (Phase 48): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof; a timed `--steps all`
      walk of a 160,000-item synthetic game on both engines, media check
      included.
      (2026-11-14 on 2234ba6: full pytest 942 passed in 107 s; full
      `npm run verify` 601/601 on Chrome; `npm run verify -- --webkit` 616
      pass and 5 partial (the headless fullscreen checks), 0 fail;
      package-proof 18/18 with .tmp/extract-demo regenerated. A 160,000-
      item synthetic game with 400 decisions, 500 media files and 9 audio
      tracks (`perf:sound -- --folder`, assembled; the validator passes it
      with no warning): `check-game --steps all` ended at step 160899,
      visited 160000 of 160000, `media: 509 files: 500 loaded during the
      walk, 9 checked after it (0 never requested)`, no errors, exit 0, in
      607 s on WebKit and 170 s on Chrome, media check included. On a
      converted corpus game the media check fell from about 23 to about 2
      minutes on Chrome (item 1).)

## Phase 49: Video segments (2026-11-14, converting agent + user)

- [x] Format, schema and validator (docs/plan.md Phase 49, item 1). Tests:
      one validator case per rule, passing and failing (order, touching,
      overlap, bounds, loop start, unknown keys, `segments` on a
      non-video item, an empty list); the schema agrees; the demo and
      audio demo still validate.
      (2026-11-14: the schema's `videoItem` takes `segments` (`minItems`
      1, `$defs/videoSegment` with no other keys); validate_content.py
      `video_segment_problems` checks order (touching allowed), end above
      start and within `durationSeconds`, loop start below end, exact
      comparison, and skips malformed shapes without a traceback (the
      schema reports them). types.ts gains `VideoSegment`; no player
      behaviour yet. content-format.md: "Video segments" (rules, the
      Space, Left/Right and note contract, what ignores the field, an
      example) and validator rule 8 (later rules renumbered; no
      reference to their numbers elsewhere). 27 tests ran red first
      (47 failed, 6 passed, the 6 already guarded by the schema), among
      them float noise (`81.03999999999999` touching; a one-step overlap
      rejected) and segments outside the item's range. Orchestrator:
      pytest tools/test_validate_content.py 268 passed, npm test 1249,
      check clean, demo and audio demo validate.)
- [x] Machine: Space steps segments (item 2). Tests (machine unit): lines
      first; a video item with no lines; time before, inside and after
      the segments; a step by index after a seek that lands short; the
      decision opens only after the last segment; route and story ends;
      auto-forward, skip, an open choice and an auto-pick ignore
      segments; a still does not step; every arrival resets; the gate
      counts as met once a segment is active.
      (2026-11-14: `MachineState.segment` (`{index, count}`, absent with
      no segment active); `Machine.setVideoClock(fn)` gives the stage's
      video time, null when it shows a still or no video, settable any
      time; unset means no step, so nothing a reader sees changes until
      item 3 wires it. The manual branch of `advance()` steps when the
      cursor ends its chain, its visual is a video with `segments` and
      the clock answers: the first segment starting after the time, then
      by index; none left, `moveForward()` as before. `segmentStage`,
      `nextSegment` and `showSegment` are the helpers item 5 reuses. The
      segment clears beside every `endedCount = 0` (every arrival, skip
      on or off); while one is active the gate counts as met and the hold
      is the text hold (chain floor and voice hold still apply). A step
      emits but is no arrival (seen set, transition, chain head kept);
      the last segment stays active under a decision it opens and at the
      story's end. segments.test.ts: 24 tests, red first (24 with no API,
      17 against a no-op stub; the 8 passing guard the branches that must
      ignore segments); faults (no gate change, re-reading the time)
      fail 2 and 7. Orchestrator: npm test 1273, check clean.)
- [x] Renderer and sound follow the segment (item 3). Tests: visual unit
      tests for the segment plan; scenario parts on Chrome and WebKit:
      the video's position after each press is inside the stepped
      segment, its loop stays inside it, leaving and re-entering plays
      the item's range, and the video's sound stays on the video
      (`videosound`'s checks) through a step and a loop.
      (2026-11-14: render/visual.ts `videoPlanFor(item, mode, rvfc,
      segment)` plays a segment's start, loop start and end (outside the
      item's range too), reporting no passes; `applyVideoMode` seeks once
      per segment change; `pass()` and the watcher follow it; a menu keeps
      it; `VisualLayer.videoTime(item)` is the clock, wired in app.ts
      `mountShell`. audio.ts: a seek of the same playing element counts as
      a jump into the video, so a step pressed just before a loop wrap
      onto a touching segment no longer leaves the sound a loop behind
      (Chrome: 74 of 186 reads off before). Found on the way, older than
      segments: in WebKit `play()` right after the restart seek at the
      file's end often restarted the video from 0 (the seek had not
      landed, so the element was still ended); `playOnFrom` waits for
      `seeked` before `play()`, for every loop-back at the file's end.
      Tests ran red first: 13 visual units (a fake element that behaves
      as WebKit did), an app.test shell test, and segments.scenario.mjs
      (5 parts, 16 checks on demo and audio-demo copies: the chain's
      last line, no lines, past the item's range, wheel back and
      forward, the Esc screen, the video sound through a step, a
      near-wrap step and the leave). Orchestrator: npm test 1288, check
      clean, smoke 6/6; Chrome segments, media, videosound, audio,
      screens, reading 246/246; WebKit segments 16/16 in 3 of 3 runs,
      videosound 31/31, media, audio and screens 197 pass and the 2
      known fullscreen partials. Before the WebKit fix, segments failed
      1 run in 4 there; one ambience check in `audio` failed once under
      a 5-file WebKit run and passed in the 4 runs after.)
- [x] check-game sees segment steps (item 4). Tests: walk.test.mjs units;
      checkgame parts on a demo copy with a six-segment item, with and
      without lines, and one as the last item: exit 0, the steps printed.
      (2026-11-14: the stage carries `data-segment="n/m"` beside
      `data-item` (app.ts `render()`); kinetic.mjs `readSegment` gives
      `current().segment` (`{index, count}`, null with no segment or an
      older player), `summary()` ends `view n of m`, and `spaceUntil`
      counts a segment change; walk.mjs counts it as a change, so six
      steps are no stuck player and a segment item at the story's end
      ends the walk at its last view; the `--steps all` cap is twice the
      items and segments plus 1,000 (check-game.mjs header). Tests ran
      red first: walk.test.mjs (9), kinetic.test.mjs (2), app.test.ts
      (`data-segment` set and removed); checkgame parts `segmentsAlone`
      (six views, no lines), `segmentsAfterLines` (views on the last
      line only) and `segmentsAtEnd` (ends at `view 3 of 3`), against
      which HEAD's walker printed no views and stopped early.
      Orchestrator: npm test 1300, check clean, smoke 6/6; Chrome
      checkgame, creator, segments, reading 97/97; WebKit checkgame,
      creator, segments 80/80.)
- [x] Left and Right, and the note (item 5). Tests: keys.test.ts; machine
      units for Left and Right; a scenario part on both engines (the
      note's text, input not blocked, keys inert elsewhere); help lists
      the keys.
      (2026-11-14: keys.ts `segmentBack`/`segmentForward` on ArrowLeft
      and ArrowRight, taken (and default prevented) only while the story
      owns the keys, so the Esc screen's and Volumes' sliders keep their
      arrows; a held arrow steps once. machine.ts `segmentForward()` and
      `segmentBack()` share `arrowStep`: inert in auto-forward, skip, on
      a choice or auto-pick and wherever Space would not step; Right
      never advances; Left goes to the segment before the one playing (or
      the last starting before the time), then by index. The note is the
      shell's pill (render/segmentnote.ts): "View n of m" for 1.6 s on
      every step, outside the overlay, not in thumbnails. Help gains a
      row "← →  previous / next view of a video" after Space; to keep the
      Esc screen's columns balanced the help rows' min-height went from
      clamp(30px, 3.7vh, 40px) to clamp(28px, 3.4vh, 37px). 27 tests ran
      red first (keys, 19 machine cases, help, segmentnote.test.ts);
      scenario parts `arrows` and `arrowsElsewhere` fail with the note
      unmounted. Orchestrator: npm test 1329, check clean, smoke 6/6;
      Chrome segments, screens, menus, reading, navigation, bookmarkmap
      211/211; WebKit segments and screens 128 pass and the 2 known
      fullscreen partials, segments 23/23 in 3 of 3 runs.)
- [x] Docs (item 6): CREATE.md, docs/verify-player.md, AGENTS.md if a
      command changed; every example run.
      (2026-11-14: CREATE.md "Camera views in one video: segments" (the
      rules, copying times exactly, a loop restart before the camera move
      ends going in `loopStartSeconds`, a synthetic example and the
      validator's line for its overlapping variant, what the reader gets)
      and under "Testing your game" the `view n of m` steps with real
      output, `current().segment`, the cap and the end rule; README.md
      the Left and Right bullet; docs/verify-player.md the `segments` row
      (7 parts), the new checkgame parts, 12 help rows; AGENTS.md one
      clause on the check-game line. content-format.md already matched
      the code. Every example was run: check-game on a demo copy with
      segments exit 0 three times on each engine, the script snippet ok
      on both, the validator on the example and its overlap. Orchestrator:
      diff ASCII apart from the help's arrows and an existing ×, no game
      named.)
- [x] Phase-closer (Phase 49): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof.
      (2026-11-14 on 6fc9603: full pytest 992 passed in 86 s; full
      `npm run verify` 627/627 on Chrome in 276 s; `npm run verify --
      --webkit` 642 pass and 5 partial (the headless fullscreen checks),
      0 fail; package-proof 18/18 with .tmp/extract-demo regenerated.
      Earlier runs while other programs loaded the machine (load average
      10-28) failed timing checks in unrelated files; the Phase 48 closing
      commit, run beside them, failed the same WebKit videosound,
      branchmap and frame-log checks, and the runs above came once the
      machine was quiet.)
