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
- [ ] Phase-closer: full suite (driver, vitest, pytest, package-proof),
      rebuild BOTH demo folders, present the updated demo to the user.
