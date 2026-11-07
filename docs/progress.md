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
- [ ] Phase-closer (Phase 35): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed, converter untouched.
