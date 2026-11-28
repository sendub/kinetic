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

- [x] Several distinct kinds sampled from the corpus
      (.app+.rpy, loose dir, .rpyc-only, .rpa-archive game, .zip; no
      .rpak found; Electron zip excluded; 30 converter tests incl.
      --label/--max-items/--files, 2026-10-31)
- [x] unrpyc vendored and pinned; `.rpyc`-only projects decompile
      (CensoredUsername v2.0.3 @ 3ae8334, 0 local mods; game D 12 .rpyc
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
      (reproduced on c2473dc, which predates the da81ceb skip
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
      conversion agent, 2026-11-01, on 81bb008: after the "Back in time"
      screen the skip stopped on the next route's first item until Tab
      was pressed again). Fixed in 44ee39b: an interstitial that ELAPSES
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
      (8a6ece8: closeIfPureAndComplete hands off to handleRouteEnd; two
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
      (580a393: machine autoPick on the open choice, countdown max(2.5 s,
      reading time of prompt + labels + ended route), 0.7 s highlight;
      reload onto a live choice re-arms it (subagent review fix);
      interstitial removed. vitest 475, playall scenario 19/19, branches
      39/39. 2026-11-02)
- [x] `c` works everywhere (user, 2026-11-02): the settings screen opens
      over a choice (the choice waits underneath, digits inert, a
      play-all countdown frozen and restarted on close) and over the Esc
      help (replacing it). Only the reset box blocks it. Tests, scenario,
      README/help text.
      (dfcc19e: toggleConfig gated only by the reset box, closes help first;
      digits inert under a panel; #config z 6 over #choice. playall
      scenario 3 new checks, screens check rewritten (t still inert behind
      help). vitest 475, playall+screens 59 pass + 2 headless-fullscreen
      partials, smoke 6/6. 2026-11-02)
- [x] Settings screen clarity (user, 2026-11-02): the two skip settings
      read as options of how Tab skips, not switches that start skipping:
      a "When Tab skips" heading over "Skip unseen content too" and "Play
      videos in full"; Play all routes gets a one-line note. Tests,
      scenario, README.
      (87d89b1: heading + indented options, controls in one column (measured
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
      slugged; e.g. "The Lantern at Low Tide" -> the-lantern-at-low-tide, demo
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
      and no heading. a config.name -> its title, demo
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
      hook lives in that game's conversion package. 25.12's worked example
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
      (2026-11-02: the corpus unreadable from the sandbox, so the
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
      a converting agent): bookmark, read past HISTORY_CAP (5000)
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
      picks; fixture is a real export from f352298. vitest 587, check
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
      a converting agent's batch has run 8+ hours. Maximise speed:
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
      pill; 7 of 18 traced runs. 74f290b not involved. The check now
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

- [x] Map shows a sibling ending route after another: in a converted
      corpus game, one decision has 3 routes; two of them are separate
      routes that each end the game, but the map draws the second as
      following the first route's line.
      Find whether the player (layout/route resolution) or the game's
      route definitions cause it. If the player, fix it and cover it
      with minimal artificial test data (nothing from that game in the
      repo).
      (Not a player bug: the game's manifest marks the first route as
      `result: "return"` (a side trip back to the choice), so the map
      correctly draws it into the join and the continuing route's
      line after it. The machine, driven with that manifest, loops it
      back to the choice and never runs the two in sequence. With that route
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
      the converted corpus game is for manual checking via .tmp, never
      committed.
      (2026-11-07: resumed after the usage limit cut off the first
      implementer. Lines, cards and marker now share one stage under a
      single CSS transform (pan desync cause: the prototype's cards were
      a separate will-change layer from the SVG); a new bookmarkmap
      scenario reads pixels after 8 drags and fails under an injected
      freeze. MAX_SCALE stays 3. Orchestrator: npm test 687 pass, check
      clean; full suite 13 scenarios, 304 checks: 301 pass, 2 PARTIAL
      (headless fullscreen Escapes), 1 FAIL = reading still expecting
      the T row, fixed (no c or t), reading 17/17 on re-run; no corpus game
      text in the diff (grep); demo-final staged in
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
      a fresh clone of 469cc7f). Cause: its hand-rolled
      `check_manifest` still reads an extension pattern from
      `$defs.videoPath`, which Phase 26 (a01bebb) removed; checkouts
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
      without bookmarks lay out identically to HEAD. A converted corpus game:
      gaps of 42 px between consecutive routes 29 -> 69, card-height
      gaps 44 -> 7 (each explained by a card or nested lines), lines
      changing height at a cut 9 of 47 -> 0 (2000 px) and 14 of 71 -> 0
      (1440 px). Orchestrator: npm test 749 pass, check clean; smoke
      6/6, bookmarkmap 29/29, continueroute 8/8, screens 67 pass, 2
      PARTIAL (headless fullscreen Escapes); branchmap 65/65 in three
      runs, and one run threw mid-scenario (60 checks, cause not
      captured; not seen again); the two branchmap edits (scroll to Home
      before the second C; "whole map in view" counts as an end) follow
      from the shorter demo map; the corpus game's cut screenshots join
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
      own band's content needs; lines join at cuts; no overlaps); a converted
      corpus game staged with a and with b, with screenshots side by side for the
      user; landed only if the user picks b, otherwise noted here and dropped.
      (2026-11-08: dropped, the user chose a. b was built uncommitted:
      `lineProfiles` with S-bends 18 px wide, levels at least 168 px long,
      a's heights kept as floors, bends also on join and return lines, cuts
      kept off bends. The corpus game: 6 bends; line held low with no card
      in its own band 1,057 -> 263 px (2000 px) and 1,237 -> 481 px
      (1440 px); some items moved to the next band. Orchestrator: npm test
      753 pass, check clean, smoke 6/6, branchmap 65/65, bookmarkmap 29/29,
      continueroute 8/8, screens 67 pass, 2 PARTIAL; both demos opened
      headless with no errors. Layout 22.5-24.4 ms against a's 17.3-18.9 at
      570 decisions with 180 bookmarks. Reverted; the working tree is a's
      1b1de3f.)
- [x] Phase-closer (Phase 42): full scenario suite, package-proof
      (rebuilds the demo); pytest not needed unless tools change.
      (2026-11-08, on 893f078: npm test 749 pass; full `npm run verify`
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
      The second (`.tmp/p43play2/demo`, a241ed2) passed on both apps but
      for the export notice and the Esc screen's uneven columns, fixed
      above; ⌘H still does nothing in the macOS app, which the user does
      not mind. The look at `.tmp/p43play3/demo` asked for the follow-up
      above. The user's look at `.tmp/p43play4/demo` (both apps, built on
      48f12cf): "Looks good now". Final automated runs on 48f12cf: full
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
      (2026-11-09 on b592f89: full pytest 673 passed in 55 s;
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
      (2026-11-09 on 1f3f703: full pytest 683 passed in 81 s;
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
      (2026-11-10 on 8fb364b: full pytest 683 passed in 87 s; full
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
      assembled from a906630 with its Mac app, matched in Safari, Chrome
      and the app: "All as described". Before it, the validator passed
      the folder and check-game showed 35 of 35 items in Chrome and
      WebKit with no errors.)
- [x] Phase-closer (Phase 47): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof.
      (2026-11-14 on a906630: full pytest 931 passed in 88 s; full
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
      (2026-11-14 on cbbd104: full pytest 942 passed in 107 s; full
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
      (2026-11-14 on ea8f222: full pytest 992 passed in 86 s; full
      `npm run verify` 627/627 on Chrome in 276 s; `npm run verify --
      --webkit` 642 pass and 5 partial (the headless fullscreen checks),
      0 fail; package-proof 18/18 with .tmp/extract-demo regenerated.
      Earlier runs while other programs loaded the machine (load average
      10-28) failed timing checks in unrelated files; the Phase 48 closing
      commit, run beside them, failed the same WebKit videosound,
      branchmap and frame-log checks, and the runs above came once the
      machine was quiet.)

## Phase 50: Loops at a file's end in WebKit (2026-11-14, converting agent)

- [x] Reproduce and diagnose in WebKit and Chrome (docs/plan.md Phase
      50, item 1): synthetic `.mkv`, `.webm` and `.mp4` clips; a range to
      the file's end as a chain, counted and a last segment; an end a
      float step below the duration; the events and element state at
      each end of the file over 3 wraps. Findings in this note; no player
      change.
      (2026-11-14: synthetic 6 s 25 fps clips, last frame at 5.96, made
      with PATH ffmpeg; a demo copy with chain, counted, last-segment,
      native-`loop` (chain and background, no range) and end-a-float-
      step-below cases per container. WebKit: every `.mkv` and `.webm`
      case 0/3, each wrapping once and then holding on the last frame;
      `.mp4` 3/3. Chrome: all 2/2. At the first end WebKit fires
      `timeupdate`, `pause`, `ended`; at every later end on Matroska or
      WebM only the periodic `timeupdate` (currentTime = duration,
      `ended` true, `paused` false), then nothing, whichever way the
      player seeks back (five ways tried on a bare element) and with the
      native `loop` attribute too; a later item reusing the element gets
      no `ended` even at its first end. VP9 in `.mp4` loops, so the
      container path is the cause, not the codec. The end a float step
      below the duration fails on every engine and container: `ended`
      fires and is ignored (rVFC boundary). Two signals tried as in-page
      patches arrive at every end on both engines: a `timeupdate` at the
      duration (up to about 0.25 s late in WebKit, needs a pause before
      the existing end logic), and the rVFC last frame plus one frame
      interval (one frame late, estimates the interval). Both need
      guards: ignore an end while seeking or below the duration, handle
      each end once. Orchestrator: reran the probe, WebKit `.mkv` chain
      wrapped once and held with only `timeupdate` at end 2. A counted
      item opened by `#start=` plays one pass on every engine and
      container, a separate lead.)
- [x] Fix (item 2). Tests: unit tests for the plan and boundary logic;
      a new scenario file, red first on WebKit, 3 wraps to the loop start
      per case on both engines; `media`, `segments` and `videosound` on
      both engines.
      (2026-11-14: render/visual.ts ends a pass at the file's end through
      one `endFile`, from whichever comes first of the frame callback's
      last frame (one frame interval after it, the interval the shortest
      step seen), a `timeupdate` at the end while the element plays on,
      and `ended` at the end; each end once (`fileEndDone`, re-armed by
      the loop-back seek and a new plan); ignored while seeking or below
      the end. Any range reaching the file's end completes there, so an
      end a float step below the duration loops. No video uses the
      element's `loop` any more (it sticks the same way in WebKit): chains
      and background videos loop by the player's seek, to
      `loopStartSeconds` (0 with no range), so an item with only
      `loopStartSeconds` now loops there instead of 0. No pause before a
      wrap (the video sound reads a pause as a wrap only while `ended`
      holds); the last counted pass still pauses at the end. New
      fileend.scenario.mjs, 15 parts (chain, counted, last segment, no
      range, end below the duration, per `.mkv`, `.webm`, `.mp4`
      synthetic clip): red first WebKit 19/30 (every `.mkv` and `.webm`
      case one wrap then held) and Chrome 27/30 (the 3 below-duration
      ends); after, 30/30 on both, WebKit 6 runs. 17 unit tests red first;
      each guard removed in turn fails the tests. media.scenario.mjs:
      `loop` false, pass ends counted from presented frames, a one-frame
      allowance on step 12's next frame. Orchestrator: npm test 1337,
      check clean, smoke 6/6; fileend, media, segments, videosound, audio,
      screens Chrome 266/266, WebKit 281 pass and the 2 known fullscreen
      partials, load average up to 29.)
- [x] A counted video opened by `#start=` plays all its passes (item 3).
      Tests: red first, a unit test or a scenario part on both engines.
      (2026-11-15: the cause, seen by logging on both engines: on a first
      load the Esc screen opens in the same task as the start item's
      play(), its hold pauses the element, the engine rejects the pending
      play() with an AbortError, and the autoplay-refused fallback
      reported all 3 owed passes, so after the resume the first end held
      and the machine moved on. Space and reloads open no Esc screen over
      a pending play(). Fix in render/visual.ts `playVideo`: a play() a
      later pause or start superseded (`startToken`) owes nothing; a real
      refusal still reports every owed pass. Unit test red first
      ([0, 0, 0] reported, expected none) and a guard that a refusal
      after a menu's resume still reports; fileend gains a `startat` part
      per container (counted, opened by `#start=` on a fresh profile):
      red 33/36 on each engine, then 36/36 (WebKit 3 runs). Report-only
      lead: Left from a counted item held at its file's end steps to a
      segment and plays the ended element at once; WebKit played on from
      0 in 3 of 28 runs. Orchestrator: npm test 1339, check clean;
      fileend, media, segments, navigation, checkgame, menus Chrome
      149/149, WebKit 148 and 1 fail at load average 44, then 149/149 on
      a rerun.)
- [x] A segment stepped to from a held end plays from its start (item 4).
      Tests: red first where it can be shown, a unit test and a scenario
      part on both engines.
      (2026-11-15: render/visual.ts `playOnceLanded`, the play-after-seek
      part of `playOnFrom`, now also starts a video `applyVideoMode`
      finds ended (a segment stepped to by Left from a counted video's
      last pass), its sound's start delay asked once the seek lands. Two
      unit tests red first (play() before the seek landed; a menu's hold
      during the seek then playing from 0). fileend gains a `back` part
      per container: the counted pass held at the end (sought to the
      duration in the page when the last-frame signal paused it just
      short), ArrowLeft, the time never below the segment's start and the
      segment looping. Before the fix WebKit failed it 1 run in 9; with
      the step's seek skipped it fails on Chrome for every container. The
      probe after the fix: 24 of 24 WebKit runs from the segment's start
      (3 of 28 from 0 before). Orchestrator: with Moonlight running, HEAD
      itself failed 11 videosound checks; once it was quit, npm test 1341,
      check clean; fileend, media, segments, videosound, menus Chrome 118
      and WebKit 128 of 119 and 129, the 2 fails gone on reruns (the
      `back` part's old reload setup on Chrome, since made deterministic;
      a videosound key-rule check, 31/31 on rerun); then fileend Chrome
      42/42 in 4 runs, WebKit fileend and segments 65/65.)
- [x] A video held at its file's end stays held when a menu closes
      (item 5). Tests: red first, a unit test and a scenario part on both
      engines; no extra pass reported.
      (2026-11-15: `setPaused(false)` sought and played even when every
      counted pass was done; play() on the ended element replayed the
      file from 0 (WebKit, and Chrome too when truly `ended`), and a
      range held inside the file played on and reported a second pass.
      render/visual.ts `passesDone(plan)` is the one test for "held at
      the end", used by `passBoundary` and by the resume, which now
      leaves such a video held; a new plan (a segment step, a new item)
      counts afresh. Side effect: after a real autoplay refusal a menu's
      close no longer retries play() on that item. Only the menus and the
      map pause the video. 5 unit tests (3 held cases red first, 2
      guards); fileend gains a `menu` part per container (Esc screen,
      then the branch map, over a held end; the setup shared with `back`
      as `holdAtEnd`): before the fix Chrome 47/51 twice and WebKit 45/51,
      after 51/51 in 3 runs on each engine; the WebKit probe held at 6 in
      3 of 3. Orchestrator: npm test 1346, check clean; fileend, menus,
      videosound, media, segments Chrome 128/128, WebKit 136 and 2
      videosound timing fails beside 4 other files at load average 7,
      then videosound alone 31/31 in 3 runs.)
- [x] Docs (item 6): content-format.md, verify-player.md, CREATE.md if
      an author's rule changes; every example run.
      (2026-11-15: content-format.md "Video playback ranges" (no
      `timeupdate` clamp or `loop=true`; a range ending past the start of
      the last frame ends at the file's end, the three signals, each end
      once, WebKit's single `ended`; chains and background videos loop
      from `loopStartSeconds`), "Video segments" (a last segment loops at
      the file's end), "Timing" (pass ends instead of `ended`; a new
      bullet: a held video stays held through the Esc screen and the
      map, a refusal reports the owed passes, a play a menu cut short is
      not one). CREATE.md: the range and segment paragraphs say an end
      past the last frame's start loops at the file's end.
      verify-player.md: the `fileend` row (24 parts) and the `media`
      row's changes. No command changed; tools/test_validate_content.py
      268 passed. Orchestrator: read the diff against visual.ts, ASCII,
      no game named.)
- [x] Phase-closer (Phase 50): full pytest, the full `npm run verify`
      and `npm run verify -- --webkit`, package-proof.
      (2026-11-15 on fa24512: full pytest 992 passed in 89 s; full `npm run
      verify` 678/678 on Chrome in 366 s; `npm run verify -- --webkit`
      691 pass, 5 partial (the headless fullscreen checks) and 2 fail, both
      in bookmarkmap (map drags, a card click) while the load average
      reached 20; bookmarkmap alone on WebKit 29/29 in 2 runs, and Phase
      50 touches no map code; package-proof 18/18 with .tmp/extract-demo
      regenerated.)

## Phase 51: Release basics (2026-11-15, user)

- [x] License (docs/plan.md Phase 51, item 1). Tests: the built bundle
      carries the notice; build_apps tests read the plist key, the
      bundle's license file and the exe's resources.
      (2026-11-15: root LICENSE (MIT, Copyright (c) 2026 Sendu Bala);
      package.json `"license": "MIT"`, pyproject `license = "MIT"` with
      setuptools>=77 (no `license-files`: PEP 639 allows no `..`).
      bundle.mjs reads LICENSE: `buildBundle` gives app.js a `/*! ... */`
      banner (dev.mjs shares the options) and index.html the notice as a
      comment right after `<!doctype html>`, so no quirks mode. Mac app:
      `NSHumanReadableCopyright` ("Made with Kinetic, Copyright (c) 2026
      Sendu Bala, MIT License") and Contents/Resources/LICENSE; exe:
      `LegalCopyright`, RT_RCDATA 1 Kinetic's text, RT_RCDATA 2 Go's
      BSD-3-Clause text read from `go env GOROOT`/LICENSE at build time,
      checked before anything is built. README "License". Tests ran red
      first: bundle.test.mjs (new), test_build_apps.py (14 failed, 16
      errored before), the real Mac and Windows builds included.
      Orchestrator: npm test 1349, check clean, smoke 6/6, Chrome
      checkgame and creator (which edit index.html) 64/64, pytest
      test_build_apps and test_assemble_folder 128 passed; dist/app.js
      and dist/index.html read.)
- [x] Kinetic's version stamped (item 2). Tests: the agreement test, the
      stamp, each `--version`, check-game naming the folder's player
      version and `unknown` for an unstamped `app.js`.
      (2026-11-15: root VERSION `1.8.0-dev`; package.json and its lockfile
      `1.8.0-dev`, pyproject `1.8.0.dev0`; tools/test_release_version.py
      enforces the agreement. app.js opens `/*! Kinetic <version> */`
      before the license banner, index.html has `<!-- Kinetic <version>
      -->` after the doctype; the build refuses a VERSION not `X.Y.Z` or
      `X.Y.Z-dev`. The player reads `KINETIC_VERSION` (src/version.ts,
      esbuild `define`, vitest.config.mjs gives tests the same). Readers:
      player/scripts/version.mjs `folderKineticVersion`, converter
      kinetic_extract/version.py `folder_player_version` (it reads the
      repo's VERSION, so no reinstall after an edit). `--version` on
      kinetic-extract, kinetic-media, validate_content, assemble_folder,
      build_apps, setup_media_tools and check-game (before the media-tools
      check). check-game's first line `<engine>: <folder> (Kinetic X)` or
      `(Kinetic unknown)`; `game.kineticVersion`. Mac Info.plist and exe
      version resource `KineticVersion`. AGENTS.md: the version rules and
      the readers. Kept on purpose: the converter's `__version__` 0.1.0,
      which feeds the ledger's `mediaTools` and so the media cache key and
      rebuild's ledger check; moving it would empty every cache and
      refuse existing ledgers at each release. Tests ran red first apart
      from version.test.mjs and the scenario checks. Orchestrator: npm
      test 1360, check clean, all seven `--version` print `Kinetic
      1.8.0-dev` exit 0, Chrome checkgame and creator 69/69, pytest on the
      six touched files 442 passed; dist/app.js and index.html read.)
- [x] The game's version in the format (item 3). Tests: validator and
      extractor cases; the demo still validates.
      (2026-11-15: schema `version` (string, maxLength 40, pattern
      `\\S`); types.ts `version?: string`; help.ts `gameVersionOf()`
      (the title's rule, nothing shown yet); parseManifest unchanged, so
      a bad `version` loads as a bad `title` does. parser.py reads
      `config.version` in `define` and `init python` only when the
      literal (plain or `_()`) is the whole value, so `"1." + str(x)`
      gives none; cli.py `derive_game_version` (first non-blank literal,
      escapes undone, trimmed, cut to 40) and `--game-version` (1-40
      characters, else a usage error); key order storyId, title,
      version; the summary prints `game version:`; a `--files` slice
      still reads options.rpy. content-format.md "Manifest" and
      validator invariant 4, extracting.md "Story ID, title and
      version", converter/README.md. renpy_demo has no options.rpy, so
      its outputs and package-proof are unchanged. Tests ran red first:
      test_game_version.py (27; 14 red), validator cases (17; 14 red),
      help.test.ts, manifest.test.ts. Orchestrator: npm test 1366, check
      clean, pytest converter/ and test_validate_content 887 passed,
      fixtures/demo validates with no `version`.)
- [x] The versions on the Esc screen (item 4). Tests: help.test.ts; a
      scenario part on Chrome and WebKit.
      (2026-11-15: help.ts `gameVersion` option: with a title the heading
      is name, space, `span.help-version` (body size, `--k-t2`), which
      stays whole on the name's last line or moves to the next as a
      unit; with no title a `p.help-version` stands in the heading's
      place; neither, no heading; all set as text. `p.help-kinetic`
      ("Kinetic <version>", micro size, `--k-t3`) sits bottom right on
      the grey ground below the sheet in the ground's last grid row
      (`--g-stamp-row`), so it overlaps nothing in the sheet and the key
      grid is untouched; the top was left to the pill. main.ts passes
      `manifest.version`; the page title stays the name. New
      versions.scenario.mjs (4 parts, 11 checks at 1920x1080 down to
      480x270: the texts, smaller and dimmer, whole after the name, the
      corner line clear of every text and control, a 200-character title
      with a 40-character version, the version alone, the Sound off pill
      and the Volumes sheet on an audio-demo copy); verify-player.md row.
      help.test.ts ran red first (6 of 26). Subagent: Chrome versions,
      screens, menus 129/129; WebKit 127 and the 2 known fullscreen
      partials. Orchestrator: npm test 1376, check clean, smoke 6/6,
      Chrome versions and screens 118/118, WebKit versions 11/11 (load
      average 74-86); the screenshot at 1280x720 read.)
- [x] `$schema` and the schema policy (item 5). Tests: validator cases;
      the extractor's copy and key; the assembler leaves the copy out.
      (2026-11-15: the schema takes an optional top-level `$schema`
      string, every other unknown key still rejected. New
      converter/kinetic_extract/schema_copy.py (`COPY_NAME`,
      `SCHEMA_REF`, `write_schema_copy`, the schema found beside the
      package as media-tools.json is); kinetic-extract writes `"$schema":
      "./manifest.schema.json"` first (manifest.js too) and the byte copy.
      assemble_folder.py leaves a top-level copy out and keeps the
      manifest as written. The player needed no change: parseManifest
      reads named fields only, back to v1.0.0. content-format.md: the
      folder layout, `$schema`, and "Schema version" (new optional fields
      never move it; it moves only when a valid folder stops being valid
      or plays differently, with a major release; an older player ignores
      unknown fields and refuses any schemaVersion but 1, an older
      validator rejects them); extracting.md, packaging.md,
      converter/README.md. Goldens: renpy_demo.manifest.json gains the
      key; test_pipeline's folder files, and the key-order checks in
      test_title and test_game_version. A non-editable converter install
      would lack the schema, as it already lacks media-tools.json. Tests
      ran red first: validator (11), test_schema_copy.py (ImportError),
      assembler (2); manifest.test.ts cases green from the start (the
      player already ignored the key). Subagent: full converter/ and
      tools/ pytest 1092, package-proof 18/18, rebuild 15/15, posters and
      validator clean on a fresh extract-demo. Orchestrator: npm test
      1370, check clean, the four touched pytest files 326 passed.)
- [x] The upgrade command (item 6). Tests: an old folder upgraded, the
      refusals, `manifest.js` untouched, the schema copy, exit codes.
      (2026-11-15: tools/upgrade_folder.py `<folder>`: exit 2 for a path
      that is not a folder or bad arguments; exit 1, changing nothing,
      for no manifest.json, a missing player/dist file, or a dist whose
      stamp is not VERSION (it says to run `npm run build`). It writes
      index.html and app.js to hidden temporary files, then renames both
      over the old (a failed write leaves the old player), keeping the
      old files' permissions; never manifest.js or app.js.map (a stale
      map is left, nothing reads it); refreshes manifest.schema.json only
      when present; runs validate_content.main, exit 1 on problems with
      the files upgraded; prints `Kinetic <old> -> <new>` (`unknown`,
      `(already current)`). Apps untouched. test_upgrade_folder.py, 21
      tests, red first (collection failed on the missing module); one
      runs against the real player/dist. Subagent's real run on a demo
      copy: upgraded, check-game `--steps 5` exit 0 naming `Kinetic
      1.8.0-dev`, a missing picture gave the validator's line and exit 1.
      Orchestrator: pytest test_upgrade_folder, test_assemble_folder,
      test_release_version 37 passed; a demo copy with an unstamped
      app.js upgraded (`Kinetic unknown -> 1.8.0-dev`, exit 0, app.js
      equal to dist, no temporary file left).)
- [x] CHANGELOG (item 7).
      (2026-11-15: CHANGELOG.md at the root: the version rules (and that
      tags before 1.8.0 predate them), `**Upgrading:**` bullets for author
      action, a 1.8.0-dev section for this phase, and one section per tag
      v1.7.0 back to v1.0.0 dated from the tagged commit: 1.7.0 Phase 50,
      1.6.0 Phase 49, 1.5.0 Phase 48, 1.4.0 Phase 47, 1.3.1 Phases 41-46,
      1.3.0 Phases 37-40, 1.2.0 Phases 30-36, 1.1.1 Phase 29's fix, 1.1.0
      Phases 25-28, 1.0.0 Phases 1-24 as the first release. Orchestrator:
      read in full; ASCII, no game named.)
- [x] Docs (item 8): CREATE.md, README.md, AGENTS.md, packaging.md,
      verify-player.md; every example run.
      (2026-11-15: CREATE.md: "Upgrading to a newer Kinetic" around
      tools/upgrade_folder.py (output, refusals, exit codes, a note for
      hand copying, where to see versions, CHANGELOG.md); the manifest's
      `version` and `$schema`, the hand-author's schema copy, kinetic-
      extract's `config.version`, `--game-version` and schema copy, the
      assembler leaving the copy out, a license paragraph, check-game's
      first line and `kineticVersion`. Examples show `1.8.0`, the version
      this phase closes as; the runs printed `1.8.0-dev` and otherwise
      match. README: the Esc bullet's versions, the upgrade command,
      CHANGELOG.md. AGENTS.md: the upgrade command and its `--version`;
      test_release_version.py checks it (8 passed). CHANGELOG 1.8.0-dev
      matched to what landed; content-format.md, packaging.md,
      extracting.md, converter/README.md small fixes. Editors: VS Code's
      relative `$schema` confirmed from its JSON language service source;
      JetBrains not confirmed, so the docs say "other editors that read
      `$schema`". verify-player.md was done in item 4. Every example run
      on demo copies (assemble, upgrade incl. refusals and a validator
      problem, check-game on WebKit, kinetic-extract `--game-version`).
      Orchestrator: read the CREATE.md diff, ASCII apart from README's
      existing symbols, no game named, test_release_version 8 passed.)
- [x] Scrub real games from the repo's text (item 8b). Tests: every
      touched test file passes with synthetic names; a grep for every
      corpus game name and corpus subpath finds nothing outside
      vendored files.
      (2026-11-15, 3d0c253 and this commit: a list of 844 corpus file and
      folder names with their variants plus 93 titles, characters and
      initials, kept only in .tmp and deleted, grepped over every tracked
      file: no hit left apart from AGENTS.md's corpus-root line, kept on
      purpose, and an ordinary word. extracting.md's survey names games A
      to J with generic paths and headings; plan.md, perf.md,
      content-format.md (the example is "The Lantern at Low Tide"),
      CREATE.md, vendor/SOURCES.md, converter comments and tests use
      synthetic or generic names with the shapes the tests need;
      progress.md notes scrubbed by the orchestrator. Player test data's
      character name became "Rowan" (branches.test.ts, mapmodel.test.ts,
      continueroute) and branchmap's `fb-` screenshots `fit-`.
      converter/tests/data/credits.rpyc, a byte copy of a corpus game's
      compiled credits, is now synthetic: build_credits_rpyc.py pickles
      stand-in `renpy.ast` nodes (same node kinds and state shape, zlib
      level 3, RPC2 slots, a fixed stamp) and checks that the vendored
      unrpyc decompiles it back to its source; no old string remains
      beyond Ren'Py keywords and the `credits` names the tests use. Git
      history still holds all of it: the user chose to rewrite history
      before the repo goes public, as its own step. Subagents: pytest
      converter/ and tools/ 1113, Chrome continueroute and branchmap
      73/73. Orchestrator: the builder reproduces the file byte for byte,
      test_rpyc, test_implicit, test_rpa 29 passed, npm test 1376, check
      clean, Chrome continueroute 8/8, `git grep` for the old name empty.)
- [x] Phase-closer (Phase 51): full pytest, the full `npm run verify` and
      `npm run verify -- --webkit`, package-proof; VERSION 1.8.0, the
      CHANGELOG dated, tag v1.8.0, `main` fast-forwarded.
      (2026-11-15 on 3283d80: full pytest 1114 passed in 96 s; full `npm
      run verify` 694/694 on Chrome; `npm run verify -- --webkit` 709
      pass and 5 partial (the headless fullscreen checks), 0 fail;
      package-proof 18/18 with .tmp/extract-demo regenerated; load
      average 9 at the start, 23 at the end. Then VERSION 1.8.0,
      package.json, its lockfile and pyproject 1.8.0, the CHANGELOG
      entry dated, tag v1.8.0 on this commit, `main` fast-forwarded.)

## Phase 52: Spoken lines (2026-11-15, user)

- [x] The manifest's `voices` and `narrator` (docs/plan.md Phase 52,
      item 1). Tests: validator cases, the demo still validates,
      manifest.test.ts.
      (2026-11-15: schema `voices` (speaker name -> `$defs/voice`) and
      `narrator`; a voice is `{file, text?, description?}`, `file` an
      `audioPath`, `text` and `description` need a non-space character.
      The validator checks voice files with every track rule (file or
      script alone, script matching, inside the folder) through one list
      of scripted files; a file shared with a track is reported once, at
      the track. Warnings, not problems: a voice no speaker uses, a
      narrator with no speakerless text. No Ogg warning for a voice: its
      clip goes to the voice engine, never to the browser. The assembler
      writes a voice's missing script and leaves its clip out, as for
      tracks. types.ts `ManifestVoice`; parseManifest checks the paths.
      content-format.md "Voices", invariant 18. Tests ran red first:
      validator 36, manifest.test.ts 7 (6 red), assembler 1.
      Orchestrator: npm test 1383, check clean, pytest validator,
      assembler, upgrade and schema-copy 369 passed, fixtures/demo
      validates.)
- [x] The helper, Mac backend (item 2). Tests: protocol, queue, cache,
      install against a local server; one real install and timed line on
      this Mac.
      (2026-11-15: apps/voice/kinetic_voice, stdlib only outside
      engine_mlx.py; JSON lines with ops status, install, cancel, remove,
      warm, voice, speak, quit and progress events; a priority queue on
      one engine thread; generated lines cached by engine, revision,
      settings, voice and text. Lock macos-arm64-1: python-build-standalone
      3.12.16 (sha256 checked against the release's SHA256SUMS), 19
      wheels pinned by hash (macOS 14 minimum; mlx built for 14, 15 and
      26), the model 2.71 GB and S3TokenizerV2 0.49 GB at pinned
      revisions; 3.29-3.32 GB in all. models/ is laid out as a Hugging
      Face cache so mlx-audio finds S3TokenizerV2 offline; HF_HOME, pip's
      cache and temp files stay in the voice folder. Real check on this
      M2: install 3.32 GB in 61 s, engine load 2.3-17.8 s, lines at
      1.03-1.11x real time after warm-up (not the 0.35x the research
      claimed: its timer stopped before mlx-audio's lazily evaluated
      decoder ran), peak 3.6 GB; Whisper read the test line right with a
      0.33 s pause before "You". Tests ran red first: 49 pass.
      Orchestrator: pytest apps/voice/tests 49 passed; the lock read; the
      real output scored.)
- [x] Faster lines (item 2b, added from item 2's real check). Tests:
      timings, Whisper, speaker match and the pause measures; samples kept.
      (2026-11-15: lines at 0.53-0.56x real time in the real helper on
      this M2, from 1.03-1.11x: 5 flow steps instead of 10, the decoder's
      voice prompt cut to 6 s (it is decoded with the line at every step),
      and the helper's own pipelined token loop (`mx.async_eval`, 13.1 to
      10.9 ms a token, identical tokens). Candidates measured on the same
      tokens: 4 steps, a 4 s prompt and Chatterbox Turbo's one-step
      decoder behind the multilingual tokens (compatible, 0.41x, but the
      speaker match fell 0.023 or more and it needs 415 MB more) failed
      the rule of a speaker match within 0.02 of 10 steps; mx.compile and
      f16/bf16 gained nothing. Streaming: `speak` with `stream: true` sends
      chunk events, the first after 1.6-1.8 s, joined by re-rendering each
      chunk's last 160 ms in the next and crossfading (0.4% RMS apart);
      it costs about 1.6x the work, so only the line a reader waits for
      should stream. Engine settings in the lock (no new files, same lock
      id; the cache key changes). The install now counts files already on
      disk in its progress (found by item 3). Tests 64 pass (red first
      except test_voice_streaming.py). Orchestrator: pytest apps/voice 64
      passed, the results table and lock read.)
- [x] The Mac host (item 3). Tests: build_apps; driver scenario parts
      with a fake helper and a local server.
      (2026-11-15: apps/macos/VoiceEngine.swift, in the app and the
      driver: the voice folder (`KINETIC_VOICE_DIR` overrides), the helper
      and lock embedded as base64 by a source both builds generate (the
      bundle listing unchanged), the Python archive downloaded with
      progress, Range resume and a sha256 check, unpacked by `/usr/bin/tar`
      and marked with its sha256; a disk check before anything is created;
      the helper run on pipes with its log in `helper.log`, restarted once
      after a crash (voices and unanswered requests resent), then status
      error; one byte scale for progress across Python and the helper;
      `unsupported` from the lock's minimum macOS. KineticHostBridge takes
      a voice host: `voice: true` in `kineticHost`, voice messages from the
      main frame only, events by `callAsyncJavaScript`, the latest status
      held until the page defines `__kineticVoice`. Test overrides:
      KINETIC_VOICE_DIR, _DOWNLOAD_BASE (rewrites the lock so the helper's
      downloads follow), _LOCK, _PYTHON, _HELPER. apps/README.md "Spoken
      lines". Real check: the Python archive from GitHub in 1.3 s, ready
      2.4 s later, a speak through VoiceEngine. Tests ran red first:
      build_apps 124, puppet.test, machost 45/45 (a stalled pipe read
      fixed). Orchestrator: build_apps 124 passed, WebKit machost and
      spoken 72/72 with a relative scenario root (the fix for it
      verified), check clean.)
- [x] The player (item 4). Tests: unit tests; the `spoken` scenario file
      on Chrome and WebKit.
      (2026-11-15: render/voiceclient.ts speaks the voice protocol
      (requests `k<n>`, `window.__kineticVoice`, status subscription;
      reference clips' base64 straight from their scripts through
      `ScriptReader.base64`); render/spoken.ts chooses lines (text, no
      recorded voice, the speaker's voice or the narrator; thoughts in the
      speaker's voice), plans the current line and the next three spoken
      lines in story order (12 items at most) at falling priorities,
      drops the ones the reader leaves, registers each voice once per
      ready session, and keeps decoded lines in a 32 MB LRU. audio.ts
      plays a line on the existing voice Sound as `spoken:<itemId>`, so
      the Voice group, `v` and every hold apply; a late line plays only if
      the reader is still there. The machine's `setSpokenHold` deadline:
      arrival + 20 s while generating, then the line's own end; skip and
      manual never wait; a recorded voice wins. A voices-only game mounts
      sound when the host offers voice. `spokenLines` (default on; the
      download is the opt-in) and the Esc row: download with size and
      note, progress with Cancel, Retry, the switch and "Remove..." through
      the confirmation box, the unsupported message. fakevoice.mjs is the
      stand-in host for both engines. Tests ran red first: npm test 1447.
      Subagent: Chrome spoken audio screens 197/197; WebKit 202 pass, 2
      partial (screens' headless fullscreen checks), on a copy of the tree
      while item 3 changed the driver build. Orchestrator: npm test 1447,
      tsc and biome clean on the player's files, Chrome spoken 27/27,
      audio and screens 170/170. WebKit `spoken` is rerun on the real
      tree with item 3.)
- [x] Streamed lines in the player (item 4b, added from item 2b). Tests:
      unit tests; spoken scenario parts.
      (2026-11-15: the line on show, when newly asked for, is requested
      with `stream: true`; prefetched lines are not, and a line already
      asked for unstreamed is kept (the helper cannot cancel a running
      line). render/spokenstream.ts schedules chunks back to back on the
      context clock (a late chunk at once), holds stop them and resume
      from the same place with chunks that arrived meanwhile; the reply
      caches the whole line and never restarts it. The hold runs from the
      first chunk to the line's end, renewed per chunk (30 s past the last
      scheduled end while more are coming); the 20 s wait covers only the
      time before the first chunk. The audio hook shows `streamed`,
      `chunks` and `final`. fakevoice.mjs streams one continuous tone.
      Tests ran red first (unit 74 across the three files; a 0.1 s gap
      mutation turned the seam checks red). Subagent and orchestrator:
      WebKit spoken and machost pass; npm test's failures are perf and
      timeout checks under load (load 6-11: a Ren'Py game and Moonlight
      running), passing alone. Chrome's audio clock ran at about 8% of
      real time in this state, failing streamed parts and the plain audio
      scenario alike; WebKit audio's one failure (a bookmark onto
      music-carry) also fails on HEAD without this change. Chrome spoken
      and audio are rerun on a quiet machine in the phase-closer.)
- [x] Casting (item 5). Tests: picking and manifest writing with a fake
      generator; one real casting run.
      (2026-11-15: tools/cast_voices.py with `design` (Qwen3-TTS 1.7B
      VoiceDesign at a pinned revision, N takes of the standard phrase,
      `index.html` and `casting.json` in `<game>-casting` beside the game,
      never inside it; existing takes kept, `--again` remakes; warnings
      for unused speakers), `pick NAME=K` (FLAC under `voices/` with its
      script by the converter's writer and the pinned ffmpeg; the manifest
      edited by splicing only the new block; manifest.js rewritten; the
      validator run) and `record NAME=FILE`; the reserved `narrator` key
      with `--narrator-key`. requirements-voice.txt pins 24 packages for a
      separate `.venv-voice` (gitignored); the tool restarts itself in the
      venv it needs. Real run on this Mac: two takes in 88 s, MLX peak 8.0
      GB, pick 0.37 s, Whisper read both takes right, the folder validates
      with no warnings. Tests ran red first: 46 pass. Orchestrator: pytest
      test_cast_voices 46 passed, `--version` and `--help` read.)
- [x] The voice demo (item 6). Tests: the builder's test; the Mac app
      checked end to end on this Mac.
      (2026-11-15: fixtures/build_voice_demo.py builds the gitignored
      fixtures/voice-demo: 18 items over 6 pictures, the research's
      six-line exchange word for word, narration, a thought, a radio
      announcer with no voice; `voices` Wren and Helen and a `narrator`,
      no `audio`. Clips in fixtures/voices (Qwen3-TTS VoiceDesign; the
      narrator cast with tools/cast_voices.py, the lowest-pitched of 3
      takes, all read right by Whisper) with a README on how each was
      made. Deterministic; builder test 16 passed (red first); validates
      clean; check-game walks the assembled folder to the end on WebKit
      and Chrome. Orchestrator, end to end on this M2 with the WebKit
      driver (the app's VoiceEngine and bridge), the real helper and model
      on the assembled demo: a real install from an empty voice folder
      fetched 3,346,136,952 bytes in 55 s with 162 progress events, then
      ready, the engine loaded in 4.6 s and lines came back; in a walk
      that listened to each line, all 17 spoken lines played on arrival
      (0-3 ms after it, prefetched while the line before played), the
      voiceless announcer stayed silent, no errors.)
- [x] Docs (item 7).
      (2026-11-15: docs/voice-reading.md rewritten to the decisions in
      force (Chatterbox live on the reader's machine, Qwen3-TTS casting),
      the Mac models round, the speed after item 2b with the 0.35x claim
      corrected, and "Questions for the user" (a to m); the Fish and Zonos
      rounds kept under "Earlier research". CREATE.md "Giving characters
      voices" (the fields, casting with design, pick and record, what the
      reader sees); README, packaging.md, stack.md (the voice install
      decision), AGENTS.md (commands and the test-only overrides) and the
      CHANGELOG's 1.9.0-dev section. Windows and streaming text follow
      items 4b, 8 and 9. Subagent ran every model-free command it
      documents. Orchestrator: the diff read, ASCII and wrap checked, no
      real game named; plan.md's download figures corrected to the lock's
      3.3 GB.)
- [x] The helper, Windows backend (item 8). Tests: install and a timed
      line over SSH, CUDA and CPU.
      (2026-11-15: engine_torch.py builds chatterbox-tts 0.1.7's own T3,
      S3Gen, voice encoder and tokenizer on the v3 multilingual weights
      (ResembleAI/chatterbox at a pinned revision, 3.21 GB), skipping the
      package's `__init__`, so no watermark and no per-line voice
      recompute; the Mac engine's settings, 5 flow steps, a 6 s prompt and
      the same streaming joins. lock-windows-x64.json: python-build-
      standalone 3.12.16, 59 wheels per variant pruned from 83 by tracing
      imports, a CUDA 12.8 and a CPU variant chosen by `nvidia-smi` and a
      minimum driver; downloads 6.83 GB (CUDA) or 3.98 GB (CPU).
      `stdin=DEVNULL` for pip and a stdin reader that polls with
      PeekNamedPipe fix two Windows hangs. On the user's PC (RTX 5090):
      lines 0.32-0.34x real time on CUDA, first streamed chunk 0.94-0.97 s,
      Whisper read all six lines, the pause before "You" 0.54-0.56 s; the
      CPU about 1.6x real time (too slow for live lines; int8 garbled a
      line). The PC's test folders (28 GB) deleted. Tests 108 pass (red
      first: 38 of 41 new; the stdin test hung 15 s before the fix).
      Orchestrator: pytest apps/voice 108 passed, the lock read.)
- [x] The Windows host (item 9). Tests: go test, vet, the cross-build; a
      headless download and helper run over SSH.
      (2026-11-15: apps/windows voice.go (settings, overrides, lock totals,
      URL rewriting, messages), voice_engine.go (the Mac engine's state
      machine, one byte scale, id mapping, relay, drop, remove, restart
      once), voice_fetch.go (net/http with Range resume and sha256; the
      archive unpacked in-process with archive/tar, refusing paths and
      links outside), voice_windows.go (GetDiskFreeSpaceExW, the helper
      hidden with CREATE_NO_WINDOW, events to the UI thread by window
      message); `kineticHost.voice` and the held status in the host
      script; voice messages taken from the game page only. build_apps
      embeds the helper and lock-windows-x64.json and refuses a Windows
      build without the lock. Over SSH on the user's PC, a Windows test
      binary with no window: the real Python archive in 0.7-1.4 s, ready
      in 4.4 s, the hidden helper (fake engine) answered voice, speak and
      a streamed line, a killed helper restarted, remove in 0.3 s; the
      test folder deleted. Started by a subagent cut off by a usage limit,
      finished by a second. Tests: go test 57, vet clean, build_apps 127
      with the real cross-build. Orchestrator: go test, vet, build_apps
      127 passed with the real lock. The windowed exe with the real engine
      waits for the user.)
- [x] Sound controls by content (item 10). Tests: unit tests; `spoken`,
      `screens`, `audio`, `machost` on Chrome and WebKit.
      (2026-11-16: render/soundrows.ts `soundContent` once per game: Music
      for music or ambience, Effects for sfx or video sound, Voice for a
      recorded `audio.voice` or, with host voice, a line the live rule
      would speak; none means no Volumes..., no Sound row, no `v`. The
      voice client only when some line needs the model. The Spoken lines
      row and `spokenLines` gone (old records load); a Voice volume of 0
      asks for no lines. The Voice row (render/voicemodel.ts): "Download
      voice model (3.3 GB)" and a ? tip in place of the slider, progress
      with Cancel, error with Retry, unsupported greyed with the reason in
      the tip, ready with "Remove voice model" by the label; with recorded
      lines too, the model on a second line. The confirm box over the
      sheet (z-index 8; Escape closes it first). Tests: npm test 1512,
      check clean, smoke 6/6, Chrome spoken screens audio videosound
      265/265, WebKit spoken screens 167 + the 2 Keyboard Lock partials,
      audio and machost clean. Orchestrator: npm test, check, Chrome spoken
      and audio 127/127, WebKit spoken machost audio 179/179, screenshots
      of the sheet absent, help, unsupported and ready with the stand-in
      host.)
- [x] A drag that ends outside the Volumes sheet leaves it open (item 11).
      Tests: a unit test and a scenario part.
      (2026-11-16: render/scrim.ts `onScrimClick` remembers the press
      target (capture phase) and passes a click only when it landed where
      the press began; the Volumes sheet and the confirmation box use it.
      screens part `volumesDrag` drags the Music slider out of the sheet
      and a press on the reset box's Cancel out to the backdrop: red on
      WebKit before the fix (sheet and box closed), Chrome red for the box
      only (its range input captures the pointer). Tests: npm test 1482,
      check clean, smoke 6/6, screens Chrome 111/111, WebKit 109 pass and
      the 2 Keyboard Lock partials of the baseline. Orchestrator: npm test,
      check, screens on WebKit (the drag part passes).)
- [x] Windows voice needs an NVIDIA card (item 12). Tests: go test, vet,
      the cross-build, apps/voice, a player unit test; the host's check
      over SSH.
      (2026-11-16: the CPU variant gone from lock-windows-x64.json (one
      CUDA build, 6.83 GB), install.py and engine_torch.py (CUDA or a
      refusal). The exe asks nvidia-smi once, hidden, cut off at 15 s
      (`checkNvidia`, `compareVersions`, `runNvidiaSmi`): no card, a
      failing nvidia-smi or a driver under `cudaMinDriver` 570.65 is
      `unsupported` with the reason as the message and the full
      `downloadBytes`, and install is refused. Test override
      `KINETIC_VOICE_NVIDIA_SMI`. The player's greyed button and ? come
      with item 10's Voice row. On the user's PC over SSH: RTX 5090,
      driver 617.42, supported; with nvidia-smi off, "Spoken lines need an
      NVIDIA graphics card. This computer doesn't have one."; the test
      folder deleted. Tests: go test 63, vet clean, apps/voice 87,
      record_lines and build_apps 148. Orchestrator: go test, vet, and
      apps/voice, record_lines and build_apps 235 passed.)
- [x] Recorded lines (item 13). Tests: the recorder with a fake engine; a
      real recording of the voice demo played in Chrome and WebKit.
      (2026-11-16: tools/record_lines.py drives the kinetic_voice helper
      from the machine's voice folder (`--voice-dir`), installing it when
      missing (install.py `install_python`: the lock's Python archive with
      resume and sha256, then the helper's install); `line_voice` mirrors
      spoken.ts `spokenLine`, a test fails if a clause of it goes. One
      mono Opus WebM per distinct voice and text, `lines/<kk>/<key>.webm`
      with its script, track `rec-<key[:32]>`, the key a sha256 of lock
      id, engine settings, clip, transcript, text and bitrate; the engines
      seed from the text, so two folders recorded apart are identical.
      Reruns record only changes and remove only its own unused files;
      atomic files, the manifest saved every 60 s and on Ctrl-C; progress
      every 10 s; `--dry-run`. Real check on the M2: 0.54x real time; the
      demo's 18 lines add 0.6 MB (18.6 kb/s); a rerun reused all 18; the
      assembled folder walks 18 of 18 in Chrome and WebKit with no voice
      host. Tests: record_lines 21, apps/voice 109. Docs: CREATE.md
      "Recording the lines", content-format.md, voice-reading.md, AGENTS,
      CHANGELOG. Orchestrator: both test files passed, check-game WebKit on
      the recorded demo passed.)
- [x] The radio's voice (item 14). Tests: test_build_voice_demo.py.
      (2026-11-16: `cast_voices.py design --takes 3` from "A brisk, crisp
      male radio newsreader in his thirties with a formal, clear broadcast
      voice."; every take read the phrase under Whisper; take 3 picked,
      the only one in a male range (139 Hz against 225 and 197 Hz, the
      narrator 96 Hz). fixtures/voices/radio.flac (mono FLAC, 24 kHz,
      10.64 s), its README row; Radio in the demo's CAST; the demo test
      now asserts every speaker has a voice. Two builds byte-identical.
      Orchestrator: test_build_voice_demo 17 passed, the clip probed.)
- [x] App wording without a browser (item 15). Tests: unit tests for both
      forms; a `screens` part with the app host.
      (2026-11-16: render/wording.ts `wordingFor(app)`, the browser's and
      the app's words in one table: the Progress help ("Saved as you read.
      Export and Import carry it to another device."), the import failure
      pill, the Import button's name and the import box. The config
      overlay asks on every paint, since a host may arrive after load.
      CLOSE_TAB_NOTE stays: it shows only with no host. Tests: wording and
      config 50 (red with the app tip set back), screens part `appWording`
      with and without the emulated host; screens Chrome 123/123, WebKit
      121 and the 2 Keyboard Lock partials. Orchestrator: wording, config
      and confirm 50 passed, check clean; the full npm test and Chrome
      screens had timeouts only, in untouched files, while the machine ran
      fsck after a reboot (load 48); they go again in the full suites.)
- [x] Phase-closer (Phase 52): full suites; VERSION 1.9.0, the CHANGELOG
      dated, tag v1.9.0, `main` fast-forwarded.
      (2026-11-16 on 639a6cc, Moonlight idle, macOS still checking the Data
      disk after a reboot, load average 3 to 5: full pytest 1240 passed
      and one stale-metadata failure in test_version.py, which passed
      after the converter's editable install was rerun at 1.9.0;
      apps/voice 87 passed; npm test 1519, check clean; Go test and
      Windows vet clean; full `npm run verify` 774/774 on Chrome; `npm
      run verify -- --webkit` 833 pass, 5 partial (the headless
      fullscreen checks) and 1 fail, the videosound check that the
      unlocking key starts the sound unsought (one seek under load),
      which passed 31/31 in each of three reruns of `videosound` alone;
      package-proof 18/18 with .tmp/extract-demo regenerated. The
      CHANGELOG entry rewritten for the finished phase (the Voice row,
      sliders by content, Windows) and dated; VERSION, package.json,
      its lockfile and pyproject 1.9.0; tag v1.9.0; `main`
      fast-forwarded.)

## Phase 53: Docs after 1.9.0 (2026-11-16, user)

- [x] Windows spoken lines in the docs (docs/plan.md Phase 53, item 1).
      CREATE.md, README.md, docs/packaging.md and any other user-facing
      doc stop describing Windows spoken lines as still to come.
      (2026-11-16: CREATE.md "Giving characters voices" speaks of the Mac
      app and the Windows program, gives both download sizes and both
      voice folders, and the Windows bullet says what it needs instead of
      "is getting the same sheet ... Until it ships"; the browser line is
      its own bullet; "Hearing it" names either app. README.md's feature
      bullet and docs/packaging.md give both apps' requirements and
      sizes. docs/voice-reading.md's opening says Phase 52 built it in
      both apps (1.9.0). Greps over README.md, CREATE.md, apps/README.md,
      docs/*.md (not progress or plan) and fixtures/voices/README.md for
      Windows-later and Mac-only wording find no other case. The
      orchestrator rewrapped the edited paragraphs to 80 columns; no
      dash or curly-quote characters added; `npm run check` clean.)
- [x] Phase-closer (Phase 53): full suites; VERSION 1.9.1, the CHANGELOG
      dated, tag v1.9.1, `main` fast-forwarded.
      (2026-11-16 on 5802937, with Moonlight streaming and macOS still
      checking the Data disk, load average up to 24: full pytest 1240
      passed in 748 s with one skip, tools/test_upgrade_folder.py's
      stale player/dist, which passed 21/21 after `npm run build`;
      apps/voice 87 passed; npm test 1519, check clean. The user chose a
      smoke check in place of the full browser suites, since nothing
      since v1.9.0 (which passed them all) changes code, only Markdown
      and version numbers: `npm run verify -- --smoke` 6/6 on Chrome and
      6/6 on WebKit. Then VERSION, package.json, its lockfile and
      pyproject 1.9.1, the CHANGELOG entry dated, tag v1.9.1, `main`
      fast-forwarded.)

## Phase 54: Item trace for tests (2026-11-17, converting agent)

- [x] Player trace (docs/plan.md Phase 54, item 1).
      `window.KINETIC_TEST_TRACE` makes the player append an item,
      choice or end record to `window.__kineticTrace` and dispatch it as
      a `kinetic:item` event, every arrival included, capped with
      `__kineticTraceDropped`; nothing without the flag.
      (2026-11-17: player/src/render/trace.ts, mounted last in main.ts
      setup. The load's screen is record 0, an item record with arrival
      `jump`. `walked` is true when the place keeps no live choice
      (`exportPlace().choice` absent), which also covers a walked screen
      past a pure choice's region, where `walkRoute` is absent. At a
      route-end re-offer `routeStack` is `[]`: the machine has closed the
      ended route's frame. Play all's countdown steps, settles, setting
      flips and segment steps write nothing. A linear manifest read to
      the end shows no end card, so no end record (types.ts EndCard);
      item 3 documents it. trace.test.ts 10 tests (a 40-item skip burst
      against the machine's path, Play all over two `continue` routes and
      a continuing route, return row, walked and map-click choices, cap,
      draining, no flag means no subscribe). Harness `openScenario({
      trace: true })`; scenario `trace` (parts traced, untraced) and its
      docs/verify-player.md row. Orchestrator: npm test 1529 passed,
      check clean, verify --smoke 6/6, `trace` 7/7 Chrome and 7/7
      WebKit, load average about 7.)
- [x] The trace in the testing tools (docs/plan.md Phase 54, item 2).
      `openGame(folder, { trace: true })` and the handle's `trace()`;
      `check-game --trace FILE`.
      (2026-11-17: `trace()` empties the page's array and resets
      `__kineticTraceDropped` in one round trip, so `dropped` counts
      since the last call; a reload restarts `n` at 0. It rejects a game
      opened without `trace: true`, and an older player naming its
      version (or "built before Kinetic versions were stamped") and the
      rebuild fix. check-game opens FILE before any browser (exit 2 when
      missing or unwritable), drains once at the open (an older player
      exits 1 before the walk), every 100 steps and after the walk, and
      prints `trace: N records written to FILE, D dropped`. Deviation:
      the handle's browser tests (a pick, a Play all run, the refusals on
      older-player copies) are `trace` scenario parts, not
      kinetic.test.mjs, which runs under vitest with no browser; it covers
      the drain and refusal wording on a fake window. The checkgame
      scenario checks the file numbered from 0 with no gap, its item ids
      matching the walk, an end record last, and the exit 1 and 2 cases.
      Orchestrator: npm test 1539 passed, check clean, verify --smoke
      6/6, `checkgame trace` 56/56 Chrome and 56/56 WebKit at load
      average 10-13; a real `--steps all --trace` walk of the assembled
      demo wrote 37 records, n 0-36 with no gap, 4 choice records, an
      end record last.)
- [x] Docs (docs/plan.md Phase 54, item 3). CREATE.md, AGENTS.md,
      docs/verify-player.md and the CHANGELOG describe the trace.
      (2026-11-17: CREATE.md "Testing your game" gains "The item trace"
      (turning it on, the records with three real examples from a demo
      walk, when records are written, reading and the cap, an older
      player and the stage's `data-item`, `trace()` with an example
      script the subagent ran to `ok` on both engines, check-game
      `--trace`), the quick check's `--trace` option, summary line and
      exit rows, and the library's option and method. AGENTS.md's
      check-game line, the `trace` and `checkgame` rows of
      docs/verify-player.md and the 1.10.0-dev CHANGELOG entry follow.
      Orchestrator: added lines ASCII only; `npm run check` clean;
      tools/test_validate_content.py, test_release_version.py and
      test_build_apps.py 469 passed.)
- [x] Phase-closer (Phase 54): full suites; VERSION 1.11.0, the
      CHANGELOG dated, tag v1.11.0, `main` fast-forwarded.
      (2026-11-17 on d40338c: full pytest 1241 passed; apps/voice 87
      passed; Go test and Windows vet clean; npm test 1539, check clean;
      full `npm run verify` 794/794 on Chrome; package-proof 18/18 with
      .tmp/extract-demo regenerated. `npm run verify -- --webkit` ran
      twice. First, at load average 15-25 from the suites themselves:
      853 pass, 5 partial (the headless fullscreen checks), 1 fail, the
      audio mix check that amb-shrink fades the rain while the hum loops
      on (121 frames off); `audio` alone then passed 2 of 3 at load 12
      and 5 of 5 at load 3-8. Second, at load 7-8: 844 pass, 5 partial,
      10 fail, all in bookmarkmap and screens (drags on the map, card
      clicks, the bookmark cascade after them), which passed in the first
      run; those two files alone failed 1 of 3 runs (2 checks). The same
      two files at v1.9.1, before this phase, failed 2 of 4 runs (the
      same 8-drag check, a card drag, a delete) plus one earlier run's
      screens skip check, so the WebKit map flakiness predates the
      trace, which no scenario but `trace` and `checkgame` turns on.
      VERSION, package.json, its lockfile and pyproject 1.10.0; the
      CHANGELOG entry dated; tag v1.10.0; `main` fast-forwarded.)

## Phase 55: Reliable WebKit map checks, plain commit messages (2026-11-17, user)

- [x] Commit messages (docs/plan.md Phase 55, item 1). AGENTS.md's
      Git section says a commit message describes the change in a short
      subject, with no test counts or run evidence.
      (2026-11-17: an 18-line paragraph and examples after the
      subagents' git rule: subject `area: what changed`, about 72
      characters, the areas taken from the last 60 subjects; a body only
      for the reason or shape; run evidence in this file's notes;
      planning and closing commits alike, the closer's subject the
      release; one good and one bad example; history kept. The Workflow
      line already sends evidence to the note. No test reads AGENTS.md.)
- [x] WebKit map checks (docs/plan.md Phase 55, item 2). The cause of
      the intermittent `bookmarkmap` and `screens` failures on WebKit
      found and fixed; 10 runs in a row pass.
      (2026-11-17: the WebKit driver's fault, not the player's or the
      waits'. WebKit fills a mouse event's `buttons` from `+[NSEvent
      pressedMouseButtons]`, the machine's real mouse, so a driver press
      reached the page as `pointerdown` with buttons 0, and one that met
      the user's own button held anywhere arrived as a chorded
      `pointermove` in place of the `pointerdown` or `pointerup`; the map
      never saw the press start or end, and every later step cascaded.
      Shown by page pointer logs of a failing card click (no
      `pointerup`), the driver logging the real buttons at 1 during a
      run, and a driver forced to report the button held failing the
      same 10 bookmarkmap checks every time. Fix in
      apps/macos/driver/main.swift (the game app untouched): the driver
      answers `pressedMouseButtons` from its own button state, as
      WebKit's test runner does, and stops with an error if it cannot;
      it also confirms mouse requests by pointer events, since the map
      cancels `pointerdown` and the mouse events waited out their full
      limit (the two files went from 64 s to 42 s). bookmarkmap checks
      a card click reaches the page as `pointerdown 1,pointerup 0`, which
      the old driver fails every time; docs/verify-player.md "WebKit"
      gains a Mouse buttons bullet; the CHANGELOG notes the fix for
      check-game and `openGame` on WebKit. Subagent: 10 of 10 WebKit
      runs of the two files at load 10-30, full `--webkit` 855 pass, 5
      partial, 0 fail. Orchestrator: npm test 1539, check clean, smoke
      6/6 on both engines, the two files 153/153 on Chrome and 5 of 5
      WebKit runs with 151 pass, 2 partial (headless fullscreen), 0
      fail.)
- [x] Phase-closer (Phase 55): full suites; VERSION 1.10.1, the
      CHANGELOG dated, tag v1.10.1, `main` fast-forwarded.
      (2026-11-17 on c5b8244, load average 3-13: full pytest 1241
      passed; apps/voice 87 passed; Go test and Windows vet clean; npm
      test 1539, check clean; full `npm run verify` 795/795 on Chrome;
      `npm run verify -- --webkit` 855 pass, 5 partial (the headless
      fullscreen checks), 0 fail; package-proof 18/18 with
      .tmp/extract-demo regenerated. VERSION, package.json, its lockfile
      and pyproject 1.10.1; the CHANGELOG entry dated; tag v1.10.1;
      `main` fast-forwarded.)

## Phase 56: Translations (2026-11-16, user)

- [x] The format (docs/plan.md Phase 56, item 1). Manifest `language`
      and `languages`, the language file's schema, content-format.md
      "Translations", the validator's checks, `fixtures/lang-demo`.
      (Evidence: docs/lang.schema.json and the two manifest fields in
      docs/content-schema.json share one canonical-tag pattern with
      `converter/kinetic_extract/language_file.py` and the player's
      `isLanguageTag` (a test keeps them equal); the script is
      `window.KINETIC_LANGUAGES["<tag>"] = <JSON>;`; `from` is the first
      8 hex of the base text's SHA-256. content-format.md "Translations"
      and rules 19-22. The validator errors on missing or differing
      files, a wrong tag, unknown ids or speakers, blank text and the
      prompt and label limits, and warns on missing, stale and long
      strings with a coverage line per language. `fixtures/lang-demo`
      (de, ja, ar; one missing and one stale German line) validates
      with exactly those 2 warnings, exit 0; fixtures/demo unchanged.
      Verified: pytest validate_content, build_lang_demo, build_demo,
      language_file, release_version 441 passed; npm test 1540/1540;
      npm run check clean. Deviation: a language file may carry
      `$schema`, as a manifest may. Per-language voice lines are left to
      item 6.)
- [x] The player's words in a catalogue, English only (item 2), with
      a pseudo-locale scenario over every screen. (Evidence:
      `player/src/i18n/`: `en.ts` the source, 177 messages (5 plurals by
      CLDR category), `t()`, `setUiLanguage` with every mounted
      component redrawing through `localized`, `<html lang>` set in one
      place for item 5's `dir`; PO files under `player/locales/`
      compiled by `npm run i18n` (also run by `npm run build`) into the
      committed `locales.generated.ts` and `messages.pot`, a staleness
      test in `npm test`; our own PO reader with tests, no new
      dependency. Test-only pseudo-locale `en-XA` via
      `window.KINETIC_TEST_LOCALE`; the `catalogue` scenario (7 parts)
      fails on any player text outside the markers or overflowing or
      clipped. It found two overflows, fixed in index.html with the
      English look unchanged (switch width a minimum; the voice
      download button may wrap). Manifest diagnostics and host-supplied
      voice messages stay English (item 7 takes the host's). Verified
      by the orchestrator: npm test 1589/1589, check clean; `verify --
      catalogue` 135/135 Chrome and WebKit; full Chrome `verify`
      909/909; WebKit smoke 6/6; WebKit screens 121 + the 2 baseline
      Keyboard Lock partials.)
- [x] Choosing and showing a game's language (item 3): the title-bar
      Language control, system-language start, fallback per string,
      `lang`/`dir` per string, reading time per language. (Evidence:
      `player/src/i18n/languages.ts` `startingLanguage` (saved, then
      `navigator.languages` by `Intl.Locale.maximize()` with script and
      CLDR region-group matching, then the base) and `uiLanguageFor`;
      `render/gamewords.ts` loads `lang/<tag>.js` (a failing file shows
      the base and a pill) and draws text, speakers, prompts, labels,
      title and version with per-string `lang` and `dir`;
      `render/languagecontrol.ts`, a listbox in the title bar whose
      capsule never adds height (equal panel height with and without
      `languages` proved at 1280x800, 700x600 and 600x900, probed at
      eight more sizes); the choice is `MachineSettings.language`, per
      `storyId`. `:lang()` system font stacks, CJK thoughts upright,
      `line-break: strict` for zh/ja. Reading factors measured from
      parallel translations of a converted corpus game: zh-Hans 2.85,
      zh-Hant 2.82, ja 2.17, ko 1.96, others 1. Testing kit: a
      `languages` launch option (Chrome `--lang`, WebKit
      `-AppleLanguages`). Verified by the orchestrator: `verify --
      languages` 58/58 Chrome and WebKit, Chrome smoke 6/6, check clean;
      npm test hit 4 perf and property timeouts at load average about
      10, and those three files passed 46/46 alone (the subagent's full
      run at lower load passed 1647/1647; its catalogue, screens and
      branches runs passed on both engines bar the 2 baseline Keyboard
      Lock partials and 4 load-timed Chrome checks that passed on rerun).
      Leads: Esc-screen controls take keyboard focus only after a click
      (Tab is the skip key), as before; live spoken lines still speak
      the base text (item 6); inline italics in the end card and resume
      notice (item 4).)
- [x] The player's words in every catalogue language (item 4): 38
      draft PO files, checked for fit in Chrome and WebKit. (Evidence:
      38 PO files in `player/locales/`, written by four translator
      subagents, each an "unreviewed draft" by its header, all 180
      messages and every CLDR plural category; none dropped, no wording
      shortened. `auditLocale` in `scripts/i18n.mjs` checks completeness,
      plural categories, placeholders and the header in `npm test`.
      `uiLanguageFor`: the reader's pick if catalogued, else the system
      language if catalogued, else English (orchestrator's change).
      Italic UI asides are a `.ui-aside` class, upright under zh, ja and
      ko. `uilanguages` scenario (10 parts): every language's Esc screen
      at three sizes with tips, reset box, decision, end card, pills,
      branch map, Volumes sheet, language list and the voice-model row,
      failing on overflow, clipping or English left where the language
      has its own words; a canvas glyph check against U+0378's box finds
      no missing glyphs in any language on either engine. app.js grows
      from 455 KB to 1,110 KB (211 KB gzipped), kept bundled. Verified by
      the orchestrator: npm test 1654/1654, check clean; `verify --
      uilanguages languages` 5379/5379 in Chrome and in WebKit;
      catalogue 150/150 Chrome; smoke 6/6 both engines.)
- [x] Right to left (item 5): logical CSS, mirrored screens, the
      branch map's layout unchanged. (Evidence: `applyDocumentLanguage`
      sets `<html dir>` from the UI language through item 3's
      `textDirection`, live on a switch. index.html moved to logical
      properties; the row hairline, the map row's chevron and the title
      marks flip under `:dir(rtl)`; native range inputs run minimum at
      the right in both engines with no pointer maths; switch knobs sit
      at the inline end when on; the branch map is always `dir="ltr"`;
      the arrow caps keep ← left of →. Urdu: taller controls and lifted
      capsule words under `:lang(ur)`, ink inside every capsule. Centred
      pills and the end card stay centred, read right to left. New `rtl`
      scenario (ar, he, and a live switch); `uilanguages` checks `dir`.
      Orchestrator looked at the Arabic Esc screen and Hebrew end card
      screenshots. Verified: npm test 1656/1656, check clean; `verify --
      rtl screens` 245/245 Chrome, `--webkit rtl` 122/122; the
      subagent's full suites: Chrome 6463/6463, WebKit 6523 + the 5
      baseline headless-fullscreen and Keyboard Lock partials.)
- [x] The route pill clear of the end card, and Arabic-script asides
      upright (item 5b, leads from item 5). (Evidence: `pillTop()` in
      render/app.ts holds every pill 8 px under the end card while it
      shows, else at 8%, re-placed on show, hide, card change, Esc and
      resize; nothing else moves. Asides and thoughts upright for
      zh/ja/ko, ar/fa/ps/ur, he/yi, th and the Indian scripts, whose
      macOS faces have no italic (checked with CoreText). New checks:
      `branches` `pillCardSession` and `rtl` `pillCard` (no intersection
      at 1280x800, 700x600 and 600x900, live resize), `uilanguages`
      upright set, an Arabic thought in `languages`, `pillTop` unit
      tests. Verified by the orchestrator: npm test 1660/1660, check
      clean; `verify -- branches rtl` 203/203 Chrome and WebKit; the
      subagent's `uilanguages languages` 5418/5418 on both.)
- [x] Spoken lines per language (item 6): `lang` to the helper,
      per-language recordings, `keepOriginalVoice`,
      `record_lines.py --lang`. (Evidence: `lineVoice` in
      `render/linevoice.ts` decides per item: the language file's own
      recording, else the base recording under `keepOriginalVoice`,
      else a live line of the shown text in the engine's language, else
      silence; base text keeps today's rule, spoken in the base
      language. 23 engine codes in one table (`nb`/`nn` to `no`); the
      helper refuses others. `speak` carries `lang` through both hosts
      unchanged; the cache key includes it. A language switch stops an
      old-language line and drops its requests. The language file's
      `voice: {tracks, items}` block in lang.schema.json, checked by the
      validator as manifest tracks are. `record_lines.py --lang TAG`
      writes `lang/<tag>/lines/` and the file's `voice` block. Verified
      by the orchestrator: pytest voice helper, record_lines,
      validate_content 557 passed; npm test 1688/1688, check clean;
      `verify -- spoken audio` 143/143 Chrome, `--webkit spoken machost
      audio` 196/196. The subagent's runs: Go tests and vet clean,
      build_apps 127 passed, smoke 6/6 both engines.)
- [x] Sound controls per language, and base recordings in the base
      language (item 6b, leads from item 6). (Evidence:
      `render/soundcontrols.ts` holds the shown language's sound content;
      a switch adds or drops the Sound row, Volumes..., `v` and its Keys
      row live, redraws an open sheet or closes it when nothing is left;
      absent sheet rows are removed, not `hidden` (item 6's rows still
      showed: fixed). The voice client is made only when a language
      needing the model is first shown; an all-recorded game sends the
      host nothing. `record_lines.py` speaks base lines in the manifest's
      `language`, refusing one the engine lacks; English keys unchanged.
      New `spoken` parts `languageControls` and `languageClient`, `audio`
      part `languageRows`. Verified by the orchestrator: record_lines 32
      passed; npm test 1701/1701, check clean; `verify -- spoken audio`
      154/154 Chrome, `--webkit spoken audio machost` 207/207. The
      subagent's `audio screens languages` runs passed on both engines
      bar the 2 baseline Keyboard Lock partials.)
- [x] The game apps (item 7): menus, window titles and early dialogs
      in the reader's language. (Evidence: the page sends `{type:
      "language", ui, dir, title?}` (render/host.ts) at boot, when a late
      host arrives, and on every change. New `host.*` catalogue keys (Mac
      menus and missing-game alert, the Windows missing-index box) in
      all 39 languages; the author-only "built without its game's
      details" box stays English. `npm run i18n` also writes
      `apps/host-words.json` (digest-checked by npm test and by
      build_apps, which refuses a stale table); the Mac app embeds it as
      Swift (shared `apps/macos/HostWords.swift`), the exe with
      `//go:embed` (`apps/windows/hostwords.go`); both match languages by
      the player's rule (45 shared cases in
      `apps/host-language-cases.json`). Mac menus start in the system
      language, then follow `ui`; window titles follow `title`. Voice
      statuses carry a stable `code` shown from `voice.code.<code>`, the
      English detail only for an unknown code. Retry and Cancel no longer
      shrink (they overflowed in six languages). Verified by the
      orchestrator: build_apps and voice helper pytest 249 passed; Go
      test and Windows vet clean; npm test 1714/1714, check clean;
      `--webkit machost` 55/55; `verify -- spoken catalogue` 228/228
      Chrome. The subagent built both apps for the language demo (not
      launched) and ran `catalogue uilanguages spoken` on both engines,
      all passing; WebKit `window` has the same 2 tab-fullscreen
      partials as the commit before it, checked by the orchestrator.)
- [x] The Mac app's per-app language (item 7b, the user checking the
      demo): Info.plist declares the catalogue's languages. (Evidence:
      `info_plist()` adds `CFBundleDevelopmentRegion` `en` and
      `CFBundleLocalizations`, the 39 catalogue tags from
      `apps/host-words.json` (already macOS's canonical forms; a test
      checks them with `NSLocale`); no `.lproj` folders are needed (test
      bundles under .tmp showed the settings panel's
      `normalizedLocalizations` lists the key alone). With
      `AppleLanguages` written into a test bundle's own defaults domain,
      as the per-app setting does, the page, the player and the menus
      followed it (ja). CREATE.md and apps/README.md say how; Windows
      has no per-program language. Verified by the orchestrator:
      build_apps tests 137 passed; the built demo app's Info.plist has
      both keys. The user checks System Settings.)
- [x] The controls follow the system language only (item 7c, the
      user's decision after checking the demo app). (Evidence:
      `uiLanguageFor({requested, catalogue})` has no pick input: the
      best catalogue match of the system languages, else English, set
      once at start (the pseudo-locale override kept). A pick changes
      the story and the host's `title` only; the document's `lang`/`dir`
      and the host's `ui` stay on the system language. Scenario
      expectations moved in `languages`, `rtl` (live: an Arabic pick
      turns the story right to left, the screen stays left to right),
      `machost` and `spoken`; docs and CHANGELOG follow. Verified by the
      orchestrator: npm test 1723/1723, check clean; `verify --
      languages rtl` 5590/5590 Chrome, `--webkit languages rtl machost`
      5645/5645. Demo app rebuilt for the user.)
- [x] The translator tools (item 8): `tools/translations.py export`,
      `import`, `status`, PO with merge and fuzzy marking. (Evidence:
      `tools/translations.py` with our own standard-library PO module
      `kinetic_extract/po.py` (GNU gettext wrapping, matched byte for
      byte by `msgcat`). msgctxt `title`, `version`, `speaker:<name>`,
      `item:<id>`, `prompt:<decision>`, `label:<decision>/<route>` in
      story order with context comments; stale entries export fuzzy,
      removed ids as obsolete; import records the hash of the PO's own
      msgid (a fuzzy entry stays stale), keeps `name`,
      `keepOriginalVoice` and `voice`, refuses another game's PO or the
      base language, adds the tag to `languages` keeping every other
      manifest byte. `status` and the validator share
      `language_reports()`. schema_copy writes `lang.schema.json` when
      language files exist; upgrade refreshes it. docs/translating.md.
      Verified by the orchestrator: translations, po, validate_content,
      language_file, schema_copy, upgrade, assemble and release_version
      tests 557 passed; a Japanese export and unchanged import of the
      language demo left the folder byte-identical; `status` as
      expected.)
- [x] kinetic-extract reads Ren'Py translations (item 9). (Evidence:
      `converter/kinetic_extract/translations.py` computes Ren'Py's
      translation identifiers as Ren'Py 8.5 does (label plus 8 hex of the
      MD5 of each say statement's canonical code, with repeat suffixes),
      the `# file:line` comment counted and used as a fallback only when
      it still names the same code; `strings` blocks feed route labels,
      prompts, speakers, title and version; style and python blocks and
      replacement files ignored and counted; a folder-name table to BCP
      47 tags with `--language-map` and `--no-translations`; language
      files written before the schema copy with `$schema`;
      `keepOriginalVoice` when items have recorded voice; per-language
      counts in the summary and ledger. `tl/` is never story flow.
      fixtures/renpy_demo gained `tl/de`, `tl/zhCN` and `tl/klingon`.
      Real check on a converted corpus game (read-only, 14 languages):
      identifiers name a statement for 4,314 of 4,316 blocks (the 2
      others changed English), every one of its 571 dialogue items
      translated in all 14, and 3,978 identifiers equal its
      auto-voice file names. Verified by the orchestrator: full `pytest
      converter/ tools/` 1524 passed (after renaming the converter's test
      file to `test_renpy_translations.py`, which clashed with
      `tools/test_translations.py`); the demo extracts de and zh-Hans,
      validates (exit 0) and `status` reports 12 and 1 of 28.)
- [x] Converter leads from item 9 (item 9b): `extend` lines,
      `_()`-wrapped names, `--base-language`, stale blocks kept as
      stale, `tl/` inside archives. (Evidence: (a) an `extend` line is
      concatenated onto the previous say's item, as Ren'Py's `_Extend`
      shows it, and translations join the same parts; only the demo's
      new `talk-020` changed in the golden, no ids moved. (b)
      `parser.character_name` reads plain, `_()` and `__()` names,
      across lines; interpolated names stay literal. (c)
      `--base-language TAG` writes `language` and lets `tl/english`
      become `lang/en.json`. (d) a changed-English block is kept with
      `from` the old English's hash only when its commented code, label
      and speaker all agree, and loses to a block for the new English.
      (e) `tl/` scripts inside `.rpa` archives are read. Real checks on
      converted corpus games (read-only): two wrapped names now translate
      15 lines in all 14 languages (coverage 573 of 645); an all-archive
      game matched 19,284 blocks of about 24k per language. Verified by
      the orchestrator: full `pytest converter/ tools/` 1552 passed; the
      demo extracts and validates, `talk-020` joined, no "extend"
      speaker.)
- [x] Archive script pairs and concatenated names (item 9c, leads
      from item 9b). (Evidence: `rpa.script_members`/`script_entries`
      walk each script path from one source: loose over archive, an
      earlier archive over a later one, `.rpy` over `.rpyc` in every mix;
      skipped members listed in the ledger. `character_name` takes the
      leading literal again (`"Ana" + x` gives "Ana") with 9b's wrapped
      and multi-line names kept. On a converted corpus game whose 68
      scripts are archived as pairs, the walk went from 619 s and 35,964
      items to 322 s and 17,982 (one per line). Verified by the
      orchestrator: full `pytest converter/ tools/` 1567 passed; the demo
      extracts and validates.)
- [x] Asset lookup speed and walk-scope consistency (item 9d, leads
      from item 9c). (Evidence: `AssetArchives` builds a stem and
      base-name index once; a test holding a verbatim copy of the old
      scan gives identical results over tricky synthetic names, and 150
      real queries on a corpus game matched. `parser.walked_scripts`
      decides the walked set once (loose top level plus what `--files`
      reaches, archived scripts outside `tl/`, item 9c's pair rule); only
      walked scripts shadow or feed translation identifiers. Archive
      members follow the loose `--files` rule; two loose `--files` bugs
      fixed (a `.rpyc` also read as `.rpy` text). docs/extracting.md
      "Which scripts are walked". The corpus game's walk: 322 s to 38 s,
      the same 17,982 items. Verified by the orchestrator: full `pytest
      converter/ tools/` 1580 passed; the demo extracts and validates.
      Known limit: a `--files` slice can number a repeated line's `_1`
      suffix differently from the whole game.)
- [x] Tools and docs around it (item 10): `check-game --lang`,
      assemble and upgrade carry `lang/`, CREATE.md "Translating a
      game". (Evidence: `check-game --lang TAG` (and `openGame`'s
      `language`) shows the game as a reader with that system language
      would, checks the tag before any browser starts (exit 2), and
      reports fallback and stale lines met; output unchanged without it.
      Assembly carries `lang/` and treats `lang/<tag>/lines/` as manifest
      voice clips are treated; upgrade leaves `lang/` byte-identical;
      build_apps needed no change (the apps open the folder in place;
      both built from an assembled translated folder). CREATE.md
      "Translating a game" (readers, authors, contributors, Ren'Py,
      spoken lines, the player's words, what is not translated) and
      "Checking a translation"; docs/packaging.md; README Languages
      paragraph; CHANGELOG 1.11.0-dev rewritten in full with one
      Upgrading bullet (re-extracting can renumber items after an
      `extend` line or an archived pair). Verified by the orchestrator:
      assemble, upgrade and build_apps tests 172 passed; npm test
      1725/1725, check clean; `verify -- checkgame` 43/43 Chrome and
      WebKit; `--lang xx` exits 2 listing en, de, ja, ar.)
- [x] Phase-closer (Phase 56): full suites; VERSION 1.11.0, the
      CHANGELOG dated, tag v1.11.0, `main` fast-forwarded. (2026-11-17,
      after rebasing the `language` branch onto develop's release 1.10.1
      and renumbering Phase 54 as 56: full pytest with apps/voice 1700
      passed; Go test and Windows vet clean; npm test 1743, check clean;
      full `npm run verify` 6580/6580 on Chrome; `npm run verify --
      --webkit` 6627 pass, 5 partial, 21 fail at load average 31-63,
      the failing files (branchmap, screens, checkgame, creator) then
      266 pass and the 2 baseline Keyboard Lock partials on a quieter
      machine; package-proof 18/18 with .tmp/extract-demo regenerated.
      VERSION, package.json, its lockfile and pyproject 1.11.0; the
      CHANGELOG entry dated; tag v1.11.0; develop and `main`
      fast-forwarded; the `language` branch deleted.)

## Phase 57: An installable toolchain, and checks for agent conversions (2026-11-17, user)

- [x] The format (docs/plan.md Phase 57, item 1). `characters` with
      speaker colours, per-item `transition`, text tags in
      content-format.md and the validator; the demo uses each.
      (2026-11-17: content-schema `characters` (`#rrggbb`, either case)
      and `transition` on image, animation and video (`dissolve` 0<s<=5;
      `fade` out, hold and in all required, each 0-5, out or in above
      0; a text item's transition is a schema error). One Python tag
      parser, `converter/kinetic_extract/text_tags.py`, with 40 shared
      cases in `docs/text-tags.json` for item 2's TS parser; `{done}`
      and `{alt}` hide their text as Ren'Py does (orchestrator's call,
      for the user's review). content-format.md gains "Transitions",
      "Characters", "Text tags", Timing's count of shown text and rules
      23-24. Validator warnings: a `characters` key no speaker uses,
      contrast below 4.5:1 against the band's densest stop `#292929`
      (a test reads the 0.84 alpha from index.html), and unknown,
      unclosed, stray or crossed tags in text, prompts, labels and
      language files; a tag never makes a text invalid. Demo: speaker
      Ines coloured, items look-dissolve, look-speaker, look-tags,
      look-fade between range-b and floor-title, the lang demo's three
      languages translating them; the demo builders fail on any
      validator warning. media.scenario's floor-chain step wheels back
      to the item before floor-title. Subagent: the touched pytest
      files 574 then 512 + 70 passed; npm test 1743; verify media,
      navigation, checkgame, languages, creator, reading 5600/5600.
      Orchestrator: the same pytest files 574 and 512 passed; npm test
      1743, check clean; smoke 6/6; the five files 5582/5583 with the
      floor-chain check failing alone too (fixed), then media 22/22.)
- [x] The player draws tags and colours (item 2). Emphasis as DOM
      elements, timing tags dropped, speaker colours, reading time
      counting shown characters.
      (2026-11-17: `src/machine/texttags.ts` mirrors the Python parser
      and passes all 43 docs/text-tags.json cases; `src/render/tagged.ts`
      builds `<i>/<b>/<u>/<s>` with createElement and text nodes, never
      innerHTML; `{p}` a newline under `pre-line`, now also on the
      choice title and labels. Tags drawn in the overlay line, prompt
      and route labels (language text too); the map, route pill and
      play-all status draw plain shown text. Colours inline from
      `characters` by the manifest's speaker key (own `#rrggbb` entries
      only); a coloured thought takes the textColor, stays italic and
      dims to 0.8 (`data-colored`) so scripts without italics still
      tell it apart; `{i}` inside a thought sets upright. `textHoldMs`
      counts shown code points. harness `currentItemId`, creator's
      reading check and playall's logger compare shown text. New
      `presentation` scenario. Lead: spoken lines send raw text with
      tags to the voice engine (item 2b). Subagent: npm test 1815;
      smoke 6/6; presentation 14/14 Chrome and WebKit; nine files
      5802/5802 Chrome, WebKit 5801 + 3 fullscreen partials + a
      checkgame stderr timing fail that passed alone. Orchestrator: npm
      test 1815, check clean, smoke 6/6; presentation, reading,
      languages, creator: WebKit 5520 pass + 1 fullscreen partial;
      Chrome 5513 + one runner "scripts completed" fail at load 40,
      then creator 33/33 alone and the other four 5488/5488.)
- [x] Spoken lines say the shown text (item 2b). The voice engine,
      the live cache key and tools/record_lines.py use the text with
      tags read, together.
      (2026-11-17: `spokenText` in player/src/render/spoken.ts
      (`shownText`, null when blank) feeds `spokenLine` and translated
      lines in linevoice.ts; tools/record_lines.py's `spoken_text` uses
      `text_tags.plain_text`, and translations check the translated
      text. The keys keep their shape with the shown text in them; an
      untagged line's text and keys are byte-identical (pinned both
      sides). Items reach recordings by track id, so older folders play
      as before and a rerun re-records only tagged lines. `{p}` stays a
      newline (both engines read whitespace as a space; punctuation
      gives the pause), `{alt}` and text after `{done}` are not spoken,
      a line showing nothing is silent. The hosts and helper pass text
      through, unchanged. content-format, apps/README.md, CREATE.md
      "Recording the lines". Subagent: npm test 1850; record_lines and
      apps/voice 150; spoken 77/77 Chrome; spoken and machost 132/132
      WebKit. Orchestrator: the same pytest 150, spoken and linevoice
      tests 76, check clean, spoken 77/77 Chrome, spoken and machost
      132/132 WebKit.)
- [x] The player's transitions (item 3). `dissolve` and `fade` that
      never delay navigation or text; navigation p95 within noise.
      (2026-11-17: `player/src/render/transition.ts` holds the rules
      (`transitionFor`, `transitionPlan`); visual.ts keeps the visible
      `<img>`/`<video>` as `#visual-outgoing` (absolute, an outgoing
      video paused on its frame) under fresh elements drawn as a cut,
      and ramps opacity with the Web Animations API: dissolve the new
      0->1 over the old, fade the old 1->0 over `out` then the new in
      after `out+hold`; a timer at the end releases the outgoing
      element as a retired video is. Runs only on a fresh `read`
      arrival (Space, auto-forward, a choice pick, reading on to a
      join) entering a new picture; every skip, the wheel, map, route
      and bookmark jumps, `e`, `u`, `#start`, loads, reduced motion and
      a menu over the stage cut; a key, pointer or wheel ends it at once.
      Same file still runs (a fade dips to black); nothing before comes
      in from black; differently shaped pictures show the old edges
      during a dissolve (documented). content-format "Transitions",
      perf.md "Transitions (Phase 57)": navigation p95 median 33.5 ms
      before, 34.0 after; first paint of look-dissolve 22.8-34.6 ms and
      look-fade 25.8-38.0 ms against 19-32 ms as cuts. Five
      presentation parts; harness `reducedMotion`. Subagent: npm test
      1843; smoke 6/6; eight files 331/331 Chrome, WebKit 338 + 3
      fullscreen partials; checkgame, creator, trace 100/100.
      Orchestrator: npm test 1842 + reach.test failing once while item
      7c's validator was mid-change, 1843 on rerun; check clean; smoke
      6/6; presentation, media, navigation 76/76 on Chrome and WebKit
      at load 80.)
- [x] The converter carries Ren'Py's presentation (item 4). Character
      colours and `with` transitions mapped; other transitions cut and
      counted in the conversion report.
      (2026-11-17: `converter/kinetic_extract/presentation.py`. Colours
      from literal `color`/`who_color` (who wins) and `what_color`,
      `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` (or bare) to lowercase
      `#rrggbb`, `kind=` inheritance, expressions left out with a report
      line; `characters` holds only shown speakers with a colour, the
      first coloured define winning a shared name. Transitions:
      `dissolve` 0.5, `Dissolve(t)`, `fade` 0.5/0/0.5, `Fade(o,h,i)`
      positional or keyword, `define` aliases and chains (a game's own
      `define dissolve` wins); a clause gives its own visual the
      transition, a bare `with` only a visual changed since the last
      line, pause, menu or with; times over 5 s clamp, `None`, zero
      times and other names cut. Summary lines `speaker colours: a of b
      speakers` and `transitions: kept ...; with no picture change N;
      cut: name xN`, ledger `transitions`; docs/extracting.md "Colours
      and transitions". Parser fixes on the way: `strip_comment` reads
      single-quoted strings, and `define` takes an init priority
      (`define -2 x = ...`, which had cut 313 dissolves in a corpus
      game). Corpus, read-only, with `--files '**/*.rpy'`: game 1 4/4
      speakers coloured, 200 dissolves and 3 fades kept, 1 cut; game 2
      8/9 speakers, 334 dissolves and 4 fades kept, 19 cut (wipes,
      punches, an ImageDissolve alias); leads became items 4b-4d.
      Subagent: test_presentation 41, converter suite 917 passed.
      Orchestrator: converter suite 917 passed.)
- [x] Ren'Py's script walk (item 4b). Loose scripts in subfolders of
      `game/` are walked by default, as Ren'Py loads them.
      (2026-11-17: every loose `.rpy`/`.rpyc` under `game/` at any
      depth, leaving out `tl/` and names starting with `.` as Ren'Py's
      loader does; one source per path unchanged; `--files` narrows,
      and a loose script it leaves out still beats the archived copy.
      docs/extracting.md "Which scripts are walked"; four tests of the
      old rule rewritten, new hidden/`tl/` and nested-story cases. Both
      corpus games convert with no `--files` (64 and 13 scripts).)
- [x] Old-style characters (item 4c). Characters made in `init:` and
      `$` lines give names and colours; a nameless Character takes its
      kind's name.
      (2026-11-17: `define`, `$ x = Character(...)` (in `init:` too) and
      `x = Character(...)` in `init python`, for Character,
      DynamicCharacter, ADVCharacter and NVLCharacter, calls joined
      over lines, later statements replacing earlier; a nameless one
      follows its `kind=` chain (`nvl` gives none); a `$` call over
      several lines is joined. Two synthetic cases.)
- [x] A corpus game's lost pictures (item 4d). The cause of game 1's
      3576 dropped visuals found and fixed.
      (2026-11-17: three general causes. Ren'Py also looks a file name
      up under `images/` (`config.search_prefixes`); Ren'Py names a file
      under `images/` by its lowercased stem with folders dropped, which
      the lookup did case-sensitively; `show screen x` was read as an
      image and dropped (now reported, no picture change).
      `timeline.asset_paths`, `images.automatic_name`, docs/extracting.md
      "Finding a script's files"; a failing-first synthetic case each.
      Game 1 dropped entries 3576 -> 14 (5 `show expression`, 2 names
      with no file), game 2 19 -> 13; game 1: 3601 items, 827 dissolves
      and 9 fades kept, 5/5 speakers coloured. Its 37 validator errors,
      text before any picture from non-story scripts joined in file
      order, became item 4e. Subagent and orchestrator: converter suite
      924 passed; with the validator tests 1410.)
- [x] The walk follows labels (item 4e). The story is read from
      `label start` through jumps and calls, not by joining files in
      name order.
      (2026-11-17: `converter/kinetic_extract/flow.py`. From `label
      start` (or `--label`; neither present falls back to file order)
      through `jump`, `call` with return at `return` or end of file,
      fall-through, `call ... from`, local labels, named menus and
      literal `renpy.jump/call`; every statement emitted once, a jump to
      a walked label or a fork's meeting point a rejoin, a repeated call
      carrying on; `if`/`while`/non-decision menu blocks walked to their
      immediate post-dominator; `show/call screen` forks over the
      screen's literal Jump/Call actions. Computed `jump/call
      expression` and `renpy.jump/call(var)` walk candidates: the
      site's own literals, then labels named by string literals in the
      game's code (orchestrator's call), the first site taking the
      shared list (documented: content back, sometimes out of place).
      `--also-label`, `--include-unreached`; Ren'Py entry labels never
      walked by default and named in the summary; end of file inside a
      call returns (a documented difference). Ledger `walk` (reached,
      unreached with dialogue counts, dynamic sites, rejoins, not
      followed). On the way: `image x:` animation blocks no longer give
      text items. Corpus, items / validator errors / unreached dialogue
      lines, file order -> now: game 1 3601/37/0 -> 3501/0/63, game 2
      8280/2/0 -> 7564/0/7 (716 bogus animation-frame lines gone), game
      3 19313/155/0 -> 19068/0/107. docs/extracting.md "The walk follows
      labels", converter/README.md, docs/stack.md. Subagent: test_flow
      22; converter suite 1010 + 1 failing on item 9's in-progress
      rename. Orchestrator: flow, parser, translations, episodes,
      presentation, rpa 237; converter suite with validate and assemble
      tests 1485 passed.)
- [x] Python-picked scenes read in place (item 4f). Each candidate
      label goes to the computed site nearest where its name is
      written, not to the first site the walk meets.
      (2026-11-17: a candidate goes to the sites tied to it (the site's
      own expression, or the Python that sets its variable: assignments
      in the site's label or outside all labels, a screen's
      SetVariable, functions they call, variables they read, 4 steps
      deep), else the nearest site in its file, else the first reached,
      settled by silent re-walks; multi-line assignments joined and
      their literals counted. Ledger `walk.dynamic[].own`. Corpus: game
      1's nightly-scene call walks 29 of its 30 tied scenes (the 30th
      reached earlier), the gallery-replay call 1 unowned label; game 1
      3524 items, 0 errors, 60 unreached lines; game 2 unchanged; game
      3 19086 items, 93 unreached lines. Subagent: test_flow 25,
      converter suite 1065. Orchestrator: converter suite 1065 passed.)
- [x] `kinetic report` (item 5). Reading time per route, speakers,
      unused files, longest lines, unknown tags; check-game reports
      overflowing lines.
      (2026-11-17: the `kinetic` console script
      (`kinetic_extract/kinetic_cli.py`, a `COMMANDS` tuple of modules
      each with `register()`), `report.py`, and the validator's branch,
      reachability and media-path code moved into
      `kinetic_extract/folder_model.py`, which tools/validate_content.py
      imports. The report: reading time at the player's defaults (shown
      code points, the per-language factor, media holds when no text
      item follows, minPlaySeconds, recorded voice lines) for every item
      once, the shortest reading to an ending, the main line and each
      route; speakers with look-alike names (case, spacing, one letter,
      not digit for digit); characters; transitions; text tag problems;
      unused files; the 20 longest lines; `--json` the same data; exit 0
      when it ran, 2 on bad input. check-game opens at the manifest's
      size (scaled into 480x270..1920x1200, 1280x720 without one) and
      warns below a step whose line runs past the screen or its column,
      then prints a `line overflow at WxH` summary; exit code unchanged.
      CREATE.md "Checking a conversion: kinetic report" and "Lines that
      overflow"; AGENTS.md bullets. Subagent: test_report 30,
      validate_content 460, test_version 20 passed; npm test 1815;
      checkgame 51/51 Chrome, 50/51 WebKit (a stderr progress-line
      check at load 15, judged timing). Orchestrator: the four pytest
      files 519 passed; walk.test 76; check clean; checkgame 51/51 on
      Chrome and 51/51 on WebKit at load 11-25.)
- [x] `kinetic routes` (item 6). The branch structure as an outline,
      DOT and JSON, agreeing with the branch map's model.
      (2026-11-17: `kinetic_extract/routes.py` copies mapmodel.ts
      `stripOf`'s line walk without geometry, from
      `folder_model.resolve_decisions`; outline with each decision,
      route, result, span and join, then decisions no line reaches,
      dropped branches, items on no line and unreachable items; `--dot`
      and `--json`. fixtures/route-shapes.json holds five shapes plus the
      demo and lang-demo with the six counts the map draws, asserted by
      test_routes.py and player/src/render/routeshape.test.ts alike.
      DOT not run through Graphviz (not installed).)
- [x] `kinetic export` (item 7). Each route as Markdown with item ids,
      in any language of the folder.
      (2026-11-17: `kinetic_extract/export.py`: `<a id>` before each
      item, `Speaker: text` with tags read to plain text, `(thinks)`,
      media, transitions and audio cues as HTML comments, choices with
      their routes after them in the map's order, items on no line last;
      one document on stdout or `--out DIR` (main.md plus one file per
      route); `--lang` marks fallbacks `[base]`, an unlisted tag exits
      2. CREATE.md and AGENTS.md. Lead: `resolve_decisions` compares
      every decision with every other (5000 take about 2 s), item 7b.
      Subagent: test_routes 17, test_export 9, with report and version
      76; npm test 1821. Orchestrator: converter suite with the
      validator tests 1410 passed; routeshape 6; check clean.)
- [x] Decisions resolved in near-linear time (item 7b). Nesting and
      branch lookups no longer compare every decision with every
      other.
      (2026-11-17: `folder_model._resolve_nesting`, one sweep in item
      order with a heap of route spans keyed (width, decision index),
      giving the old narrowest-span, earliest-tie answer; report looks
      branches up by id with a parent-to-children map; routes'
      `build_model` bisects to the first sibling in a span; the
      validator's `reach_warnings` uses the same sweep. At 20,000
      decisions (218k items): resolve 32.85 s -> 0.11 s, routes 36.77
      -> 0.62, report 67.65 -> 4.21, validator branch checks 35.10 ->
      0.35; jsonschema's own 30 s on 218k items unchanged. Equivalence
      with the old all-pairs code (kept in the test) on 400 seeded
      shapes each, byte-identical outputs on 300 shapes and the demo.
      Leads: the validator never exits on a `continueAt` before its
      routes, and an unhashable decision id raises in routes (item 7c).
      Subagent and orchestrator: report, routes, export,
      validate_content and test_decision_scale 521 passed.)
- [x] Malformed branches never hang a tool (item 7c). The validator,
      report, routes and export stop cleanly on bad branches.
      (2026-11-17: `folder_model.span_problems` (a route not after its
      `after`, overlapping routes, a `continueAt` not after every route
      end, in the validator's own words) gates the reading walks;
      branches the player only drops still show in routes. The
      validator skips reach warnings then and exits 1 at once; report
      prints "not worked out: the branches are malformed", a
      `branchProblems` key and exit 1; routes and export print the
      problems on stderr and exit 1, export writing nothing.
      `shown_by_play_all` stops on a repeated state and `_shortest_ms`
      on a backward join; routes takes unhashable ids and non-object
      branch entries. CREATE.md and docstrings. test_malformed_branches
      (34, each tool in a child process with a 30 s limit, 400 fuzzed
      shapes); the 20,000-decision bound raised to 10 s for load.
      Subagent and orchestrator: the six files 555 passed.)
- [x] Media tools for Windows and Linux (item 8). Windows and
      linux-x86_64 pinned against the shared goldens, `macos-x86_64`
      dropped, AGENTS.md's pin rule rewritten.
      (2026-11-17: the pins waited on the user, then item 8b recorded
      them with per-platform goldens. Every x86_64 build
      differs from the shared goldens on the same 6 cases
      (ffmpeg.audio-loop-aac, audio-transcode-opus, poster-frame,
      transcode-mp4, transcode-odd-mp4, pillow.poster-jpeg): gyan.dev
      9.0.2 essentials and BtbN n9.0.2-17 on Windows, Martin Riedl's
      linux-x86_64 in WSL, every download matching its publisher's
      checksum. gyan and BtbN give identical hashes, and Linux matches
      them on the audio and JPEG cases, so the CPU, not the publisher,
      makes the difference; nothing was pinned. Done: `macos-x86_64`
      removed; `windows-x86_64` added (gyan zip, sha256 null);
      `platform_key`, `.exe` names, UTF-8 tool output; setup's hidden
      `--pins FILE`, `sha256Url` with a stricter checksums-file parse,
      one download per archive, `.exe` members under `bin/`, archive
      checksums saved only after the self-test passes; a null-pin
      message naming the pinned platforms; AGENTS.md's pin rule as the
      user decided; CREATE.md, converter/README.md, docs/stack.md.
      Subagent: on Windows (path with spaces) and in WSL the self-test
      ran every case and a fixtures/renpy_demo extract, validate, ship
      and rebuild (15/15) passed with the candidate tools; Windows
      test_setup_media_tools 23 passed, 2 skipped; PC and WSL cleaned.
      Orchestrator: setup, media_tools, media_ship and poster tests 84
      passed; Mac setup self-test 22 cases passed.)
- [x] Per-platform goldens (item 8b). A platform holds its own golden
      for a case a CPU difference changes; rebuild names the platform
      that can verify; Windows and linux-x86_64 pinned.
      (2026-11-17: code in a3bfba7: `selftest.cpuDependent` (the 6 cases, the user's
      to extend) and `selftest.platformGolden.<platform>.<case>`,
      checked by `check_platform_goldens`; only the `--pin` that first
      pins a platform's archives records its goldens, refusing any
      difference outside the list; `--repin` re-records a platform's
      own; `run_tools()` carries `platform`, so the reuse cache keys on
      it and every ledger's `mediaTools` records it (absent = macos-arm64);
      rebuild on another platform prints "made on X; rebuild there to
      verify" and exits 3. Pins recorded by the orchestrator with
      `--pin` on each platform, on a clone of a3bfba7, both archives
      matching their publisher's checksum and the other 16 cases
      matching the shared goldens. windows-x86_64 (gyan.dev 9.0.2
      essentials zip): archive 60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba
      for both tools; goldens audio-loop-aac 3c8b6f4d330baecc41324ce9146b1b384fec650117b7c9581c759d31af715c12,
      audio-transcode-opus 96e83e04c4e92796b6b353fcd11f6d4e0cb7692fbafea909ea2c8c36dc4d8491,
      poster-frame 4992db50006c9aa0a416d8e56e976ffee052e291de3c5ba0366edee7decd68f5,
      transcode-mp4 e84519446e8d8087b1feaeb487571b5122cb4655035a4eb3e9fc0346206be8af,
      transcode-odd-mp4 121b68a7b3e38be014153f96533fb0e23b5a2a713132885b6dc83eb3f94fad18,
      pillow.poster-jpeg 4c22a776771394f88a168092b65d99075eaee9f0d671eb5015849597ed5bee24.
      linux-x86_64 (WSL): ffmpeg fa8ecf4abbd290d98f7d188b8649cc6b391ae209a98452be955a15aab1909d7f,
      ffprobe 3f428c49070be3d24ec338602b76d412e401ffcb8a5641ef0e729181a232fc32;
      goldens audio-loop-aac and audio-transcode-opus and
      pillow.poster-jpeg as Windows, poster-frame a5e385c00f4d0ddbaa6be09b5317b65d0400c24b57e1f9b1c7dde556594ed259,
      transcode-mp4 29ff47bbf0a4c42fa7fa8a83a2cfcd271a5edc30a79f30c76ad4c2bc671ffdd4,
      transcode-odd-mp4 58ac83951bba95dd9e2f961687ad79341205ce727d84984d3b0a048d1e1b7f88.
      Plain setup then passed 22 cases on Windows, in WSL and on the
      Mac; PC and WSL cleaned. Found: setup wrote the pin file with
      CRLF on Windows (normalised by hand here); now all 19
      `write_text` calls in the package and tools/translations.py pass
      `newline="\n"`, test_lf_output.py (a Windows-text-mode fixture over
      setup, extract and ship, plus a static check of every writer), a
      scratch Windows `--pin` byte-identical to the committed file, and
      `.gitattributes` `* text=auto eol=lf` (the orchestrator's call;
      every indexed file was already LF) so Windows checkouts copy LF
      schemas. Docs: macos-arm64, windows-x86_64 and linux-x86_64
      pinned, linux-arm64 not, rebuild on the making platform (CREATE.md,
      README.md, packaging.md, the CHANGELOG media bullet and a new
      Upgrading bullet). Follow-up: LF tests 4, converter and tools
      1982; orchestrator: LF, setup and media_tools tests 72. Subagent: touched
      tests 128, converter and tools 1978; scratch pins and a
      renpy_demo extract and rebuild (15/15, exit 3 for a foreign
      ledger) on both platforms. Orchestrator: touched tests 128 then
      68 with the pins; Mac setup unchanged.)
- [x] The `kinetic` command and the wheel (item 9). One command with
      the old names as wrappers, the player bundle and a bundled
      check-game inside; installs and runs from a fresh venv.
      (2026-11-17: subcommands setup, extract, media, validate,
      assemble, upgrade, check, report, routes, export (`apps` comes
      with item 10), each passing its arguments to the tool's `main`.
      validate_content, assemble_folder, upgrade_folder,
      setup_media_tools and windows_resources moved into
      `kinetic_extract/`; the tools/*.py files are wrappers that also
      stand in for the module on import. `paths.py`: a checkout behaves
      as before; an installed wheel reads `kinetic_extract/data/` (pins,
      schemas, self-test samples, unrpyc, player bundle, check bundle)
      and writes media tools and caches to per-user folders (macOS
      Application Support and Caches, `%LOCALAPPDATA%\Kinetic`, XDG),
      `KINETIC_HOME` overriding. The distribution is renamed `kinetic`
      (other venvs: `pip uninstall kinetic-extract` first; AGENTS.md
      says so) with jsonschema declared. `kinetic check` runs an esbuild
      bundle of check-game with puppeteer-core (2.4 MB) on the system
      Node, needing 22.12.0, with a hook for item 10's prebuilt WebKit
      driver and a Chrome fallback; `kinetic.mjs` honours
      `KINETIC_SCRATCH_DIR`. tools/build_wheel.py builds the player
      fresh into staging: kinetic-1.12.0.dev0-py3-none-any.whl, 80
      files, 1.05 MiB, into `dist/`. AGENTS.md, CREATE.md "Without a
      checkout", docs/packaging.md "Installing the tools". Hand run
      from a fresh wheel venv outside the repo: `kinetic setup`
      downloaded and self-tested (22 cases), extract, validate,
      rebuild 15/15, assemble and check passed. Subagent: converter and
      tools 1918 + 1 failing in item 4f's in-progress test_flow; npm
      test 1853. Orchestrator: kinetic_cli, paths, check, build_wheel
      (the wheel installed and run) and release_version 68 passed;
      converter and tools without test_flow 1922; npm test 1853, check
      clean; smoke 6/6; checkgame and trace 67/67.)
- [x] Prebuilt app hosts (item 10). Hosts read their story settings at
      launch; `kinetic apps` builds both apps with no Swift or Go.
      (2026-11-17: the Mac host reads Info.plist `KineticStoryId`,
      `KineticTitle`, `KineticWindowSize`, `KineticVersion` once
      (apps/macos/app/HostSettings.swift); the exe reads RCDATA 3,
      compact JSON, once with FindResource/LockResource
      (apps/windows/settings*.go), empty settings showing its "made
      without its game's details" box. `--self-check FILE` on both
      writes the settings and exits (0, 1 unwritable, 2 no FILE), no
      window. `kinetic apps` (`kinetic_extract/apps.py`, with
      `app_hosts.py` finding the wheel's hosts or building them in a
      checkout into `.tmp/app-hosts/<kind>-<hash>/`): Mac copies the
      bundle, writes Info.plist, Pillow icns, LICENSE, signs ad hoc with
      codesign; Windows rewrites the exe's last-section `.rsrc` in pure
      Python (`windows_resources.read_resources/replace_resources`:
      VirtualSize, SizeOfRawData, SizeOfImage, the data directory, a
      fresh checksum that imagehlp agreed with), keeping manifest and
      licences and writing icon, version and settings; with Go's
      `-buildid=` the rewrite equals linking a .syso byte for byte bar
      the checksum. tools/build_apps.py is a wrapper; assemble's
      --mac/--windows work from a wheel. The wheel grows 1.1 -> 4.85 MB
      (exe 3.26 MB compressed, WebKit driver, Mac host, host words,
      LICENSE). CREATE.md, apps/README.md "Game settings",
      docs/packaging.md "The app hosts", AGENTS.md. Subagent: Mac and
      Windows PC self-checks right (a UTF-8 title, null window size,
      the raw host empty; VersionInfo and icon right; PC folder
      deleted); pytest tools and converter 1956; npm test 1853; Go test
      and vet; Swift tests; WebKit smoke 6/6 and machost 55/55; wheel
      test with no swift or go on PATH. Orchestrator: build_apps,
      build_wheel, kinetic_cli 199 passed; Go test and Windows vet
      clean; assemble of the demo with both apps, the Mac self-check
      JSON right, codesign verify, the exe's 13 resources read back;
      WebKit smoke 6/6, machost 55/55; npm test 1853.)
- [x] Release and install docs (item 11). CREATE.md around `kinetic`,
      AGENTS.md and README.md, the closer's wheel step, package-proof's
      wheel stage.
      (2026-11-17: CREATE.md now leads with "Installing Kinetic" (from a
      release: the wheel URL and `kinetic setup`; in a checkout), then
      converting with the agent's checks in order (validate, report,
      routes, export, assemble, check, media rebuild) and "What the
      converter carries", then hand-authoring with "Text tags", "Speaker
      colours", "Transitions" and "Title, credits and content warnings"
      (an example manifest validated and walked); every cited heading
      still resolves. README.md install bullet and features; AGENTS.md
      commands as `kinetic <sub>` and the closer's wheel step (build,
      notes from the CHANGELOG, `gh release create --verify-tag` as
      sendub); CHANGELOG 1.12.0-dev written with three Upgrading
      bullets; docs/packaging.md sizes re-measured (app.js 1.28 MB, the
      wheel 4.85 MB). package-proof gains a 10-step wheel stage (build,
      fresh venv, version, setup, extract, validate, report, assemble
      with both apps, check on WebKit's prebuilt driver, the Mac
      `--self-check`). The docs say converting needs an Apple silicon
      Mac while item 8's pins wait. Subagent: package-proof 28/28;
      release_version and validate 471; npm test 1853. Orchestrator:
      release_version and validate 471 passed; check clean; added
      non-ASCII lines are moved existing text only; package-proof
      28/28.)
- [x] The validator for gates (item 11b). Silent when clean, coverage
      in `kinetic report`, `--strict` exits 3 on warnings, `--json`.
      (2026-11-17: `warnings_by_kind()` with fixed kinds (unreachable,
      audio, voice, character, textTag, translation, poster), each
      printing its lines and count only when it has warnings; the
      coverage lines and the unconditional "0 poster warnings" gone
      from the default output. `--strict`: warnings alone exit 3 (1
      problems wins, 2 bad arguments). `--json`: problems, warnings by
      kind (all seven keys), coverage per language (strings,
      translated, missing, stale, unchecked, long, percent) and
      exitStatus, nothing on stderr. `language_coverage()` shared with
      a new report section "Translation coverage" (text, and `coverage`
      in its JSON). CREATE.md (a `--strict` exit table and a `--json`
      example), content-format, translating.md, extracting.md,
      AGENTS.md, CHANGELOG with an Upgrading bullet. Subagent:
      validate_content 473 (13 new gate tests), demo builders,
      translations, report and others 261; converter and tools 1999;
      npm test 1853. Orchestrator: demo silent, exit 0; lang-demo
      `--strict` exit 3 with its 2 warnings; `--json` shape right with
      stderr empty; a clean two-language folder silent on both streams,
      exit 0 under `--strict`; report's coverage section; the four test
      files 632; npm test 1853.)
- [x] A README for players and authors (item 11c). A short overview
      with screenshots of the Esc screen, branch map and bookmarks; the
      detail moved to docs/player.md; AGENTS.md's closer rule to update
      the docs and screenshots.
      (2026-11-17: README.md 4,132 -> 948 words: what Kinetic is (a
      folder from disk or its own Mac or Windows app), "Why not
      Ren'Py?" (nothing to install, every step within a frame, the
      wheel through everything read, the map, no save slots, Play all
      routes, languages and spoken lines, a conversion checkable without
      watching), "A look around" with four screenshots and captions,
      "For players", "For authors" (the v1.12.0 wheel line, kinetic
      setup, extract, report, assemble, check, apps), licence.
      docs/player.md (4,297 words) holds every key, control, screen and
      setting, checked against keys.ts, branchmap.ts and the catalogue.
      Images in docs/images/ (1280x720; bookmarks 1280x476) from
      `npm run screenshots` (player/scripts/screenshots.mjs, the testing
      library, pinned clock and UTC, byte-identical across runs) on a
      new showcase story, fixtures/build_showcase_demo.py (gitignored
      output, 3 decisions, 6 routes; fixtures/demo unchanged, since its
      shape cannot show a fully played fork and an unreached decision
      at once): the map shows a 2/2 fork with a bookmark on each route
      and its return line, a 1/2 decision with "you are here", and an
      unreached decision as a faded "?" with Spoilers off; the bookmark
      close-up the newest card's gold outline, delete x and time; the
      Esc screen; a coloured, tagged line. Links that named removed
      README headings point at docs/player.md; code comments that cited
      README bullets now cite docs/player.md (comments and two test
      names only). AGENTS.md: `npm run screenshots` and the closer's
      rule to update the docs and regenerate the screenshots when what
      they show changed. Subagent: npm test 1853, check clean, showcase
      and demo builder tests 4, no missing links, two identical
      screenshot runs. Orchestrator: looked at every image; links
      checked; builder tests 4; npm test 1853; check clean; the source
      diff is comments and two describe names.)
- [x] The demo on GitHub Pages (item 11d). The demo tour published
      to Pages, the player proven over HTTP(S), linked from the README,
      republished by the closer.
      (2026-11-17: tools/publish_demo.py builds the player fresh into
      .tmp, builds and assembles fixtures/demo (no apps) with
      `.nojekyll`, and force-pushes one parentless commit "demo: Kinetic
      <version>" (source commit in the body) to `gh-pages` through a
      temporary index, refusing a dirty VERSION, LICENSE, player/ or
      fixtures/ (testing and scenario scripts excepted); `--dry-run`.
      assemble_folder gains `assemble(content, out, dist)`. Testing
      library: `serve.mjs` (GET/HEAD, MIME types, single ranges 206/416,
      404 for missing or escaping paths), `openGame` `http` (`true`,
      `{port}`, `{url}`), check-game `--http` and `--url`; Chrome's own
      favicon request is left out of errors() when serving; the player
      unchanged. Scenario `http`: walk 36/36, bookmark with card, reload
      and reopen resume per origin and port, music plays, 11/11 Chrome
      and WebKit. Published: gh-pages ee03f079 from develop 0136021;
      GitHub enabled Pages on gh-pages / with HTTPS enforced, built in
      about 20 s. README "Try it in your browser" line; CREATE.md
      "Serving from a web host"; packaging.md; verify-player.md;
      AGENTS.md (the tool and the closer republishing). The user's
      decision recorded: releases attach no demo builds. Subagent: npm
      test 1869; creator, checkgame, http 95/95 Chrome; publish,
      release_version, assemble 33; the live URL walked 36/36 on Chrome
      and WebKit. Orchestrator: the live index.html, app.js (stamp
      1.12.0-dev), manifest.js and .nojekyll return 200 with the right
      types; check-game `--url https://sendub.github.io/kinetic/` walked
      36/36 with no console or page errors; http 11/11 Chrome; npm test
      1869, check clean; the three pytest files 33.)
- [x] Phase-closer (Phase 57): full suites; VERSION 1.12.0, the
      CHANGELOG dated, tag v1.12.0, `main` fast-forwarded, the wheel
      attached to the GitHub release.
      (2026-11-17 on e751dc3, load average 2-6: full pytest converter
      and tools 2009 passed; apps/voice 114; Go test and Windows vet
      clean; npm test 1869, check clean; full `npm run verify` 6625/6625
      on Chrome; `npm run verify -- --webkit` 6694 pass, 5 partial (the
      headless fullscreen checks), 1 fail: videosound's "after the
      Escape that closes the help screen..." with one seek after the
      unlocking key (seeksAfterKey 1, frames in step), which then
      passed 3 of 3 alone and once beside audio, segments and media
      (160/160), a one-off timing miss; package-proof 28/28. Docs
      current (README install line names v1.12.0; screenshots taken
      after the last visible change). VERSION, package.json, its
      lockfile and pyproject 1.12.0; the CHANGELOG entry dated; tag
      v1.12.0; `main` fast-forwarded; the wheel built and attached to
      the GitHub release v1.12.0 with the CHANGELOG entry as notes; the
      Pages demo republished from the release commit.)

## Phase 58: A wheel an agent can check with (2026-11-20, converting agent)

- [x] The controls' language, documented (docs/plan.md Phase 58, item
      1). How a reader changes it per platform; no manifest setting;
      check scripts pin their words with `language`, proved on Chrome
      and WebKit.
      (2026-11-20: docs/player.md "Languages" lists how to change the
      player's words on the Mac app (Language & Region, whole Mac or the
      app alone), the Windows app (display language, sign-out) and a
      browser; CREATE.md "Translating a game" says no manifest setting
      pins them, by design, and that a check reading the player's words
      passes `language` (`--lang`); "Testing your game" says
      `language: "en"` gives English controls on a German Mac; README's
      languages line links to docs/player.md. The library needed no fix.
      Subagent's calls: the test is a `controlsLanguage` part of the
      creator scenario (kinetic.test.mjs is browserless); the German
      machine is a test-only `KINETIC_TEST_SYSTEM_LANGUAGES` in core.mjs,
      passed to Chrome and the WebKit driver as an earlier
      `-AppleLanguages` argument (macOS only; a fake home folder had no
      effect). The part opens the demo twice: without `language` the
      page and Esc screen are German, with `language: "en"` English, no
      errors; it failed on both engines with openGame's language
      passing removed. puppet.test.mjs checks the argument order.
      Subagent: npm test 1869 (mapmodel's timing test failed once at
      load 18, passed on rerun); check clean; creator 36/36 Chrome and
      WebKit. Orchestrator, load 12-18 from item 3's agent: npm test
      1868/1869 with the same mapmodel timing test failing, 86/86 on
      rerun; check clean; creator 36/36 Chrome, 36/36 WebKit.)
- [x] Whole help texts (item 2). Every subcommand's `--help`
      description a whole sentence, true for a checkout and a wheel.
      (2026-11-20: upgrade and assemble take a `DESCRIPTION` constant in
      place of the docstring's first line; upgrade's docstring, help and
      refusal say "this Kinetic's" in place of "this clone's"; report,
      routes and export drop their "`kinetic X <folder>`:" fragments and
      docs/plan.md pointers for a sentence; `kinetic media` and its ship,
      rebuild and posters gain sentence descriptions. Subagent's calls:
      help texts point to CREATE.md and docs/, never docs/plan.md, which
      a wheel lacks; the lower-case summaries in `kinetic --help`'s list
      stay. New tests in test_kinetic_cli.py: each of 14 descriptions
      starts with a capital, ends with "." and balances its parentheses
      (8 failed before the fix), and upgrade's names no clone.
      Subagent: test_kinetic_cli 40 passed; the touched modules' tests
      207 passed, 1 skipped. Orchestrator: test_kinetic_cli,
      upgrade_folder, assemble_folder, report, routes, export 136
      passed, 1 skipped; `kinetic upgrade --help` reads whole.)
- [x] Upgrade a copy, or preview (item 3). `kinetic upgrade --to NEW`
      (media hard-linked, the folder only read) and `--dry-run`.
      (2026-11-20: `--to NEW` hard-links the media the manifest and its
      listed language files name (`report.media_files`, referenced files
      less the language files) and copies everything else with
      `copy2`, symbolic links recreated; it builds in a hidden
      `.NEW.<random>.upgrading` beside NEW, upgrades there and renames
      to NEW last, removing the hidden folder on any exception or
      Ctrl-C. `--dry-run` prints "Dry run: nothing is written.", the
      would-copy counts, the version line and the files it would
      replace, then validates the folder as it is. Docstring and
      CREATE.md "Upgrading to a newer Kinetic" give the staged workflow
      and the shared-storage warning. Subagent's calls: every problem
      with NEW (the folder itself, inside it, containing it, existing,
      a missing parent, another volume) exits 2 before the exit-1
      refusals; an unreadable manifest with `--to` refuses rather than
      copy everything unlinked; index.html, app.js, schema copies and
      the manifest files are never linked; a fifo or socket fails the
      copy; SIGKILL can leave the hidden folder, documented as safe to
      delete. Tests: 31 new in test_upgrade_folder.py (inodes, copies,
      source unchanged by bytes, mode and mtime, 9 refusals with and
      without dry run leaving the tree unchanged, injected failures and
      KeyboardInterrupt, an ad hoc signed app passing `codesign --verify
      --strict` after the copy, dry-run output), 30 failing before the
      code. Subagent: test_upgrade_folder and test_kinetic_cli 93
      passed; test_report 34; a real app and exe built by `kinetic apps`
      copied by `--to` (app verifies, exe identical). Orchestrator: the
      same three files 127 passed; on a demo copy `--dry-run` wrote
      nothing, `--to` linked 28 media (same inode, 2 links), its app.js
      equals player/dist's, and a second `--to` exits 2.)
- [x] The testing library in the wheel (item 4). One bundled module,
      `kinetic check --library` printing its path, `openGame`'s
      `savedState`, the handle's `storageKey` and `savedState()`.
      (2026-11-20: bundle-check.mjs builds the library as
      `data/check/kinetic.mjs` (about 2.4 MB, puppeteer-core inside) and
      check-game on top of it (about 24 KB, importing `./kinetic.mjs`),
      so puppeteer-core is in the wheel once. New `testing/scratch.mjs`:
      `KINETIC_SCRATCH_DIR`, else a checkout's `.tmp`, else
      `<per-user cache>/check` by paths.py's rule, so an imported library
      needs no env var. `kinetic check --library` prints the bundle's
      path (a checkout's `player/scripts/testing/kinetic.mjs`) with no
      Node; exit 1 when the file is missing, 2 with other arguments.
      `openGame` `savedState` writes the record under the story's key
      from an `evaluateOnNewDocument` script queued ahead of the
      player's IndexedDB open, first load only (a sessionStorage mark,
      since the WebKit driver cannot remove page scripts); a kept
      profile's bookmarks and seen records stay; a non-object or
      non-JSON value throws before any browser. Handle: `storageKey`,
      `savedState()`. CREATE.md: setting up from a release, the test
      script importing the printed path, "Starting from a saved state",
      the API list; packaging.md the new file. Subagent's calls:
      check-game built on the library rather than hashed split chunks;
      "bookmarks carried over" read as a seeded record leaving a kept
      profile's bookmarks alone, since the record holds none. Tests: a
      `savedState` part in the creator scenario (7 checks: read back,
      hand-written record opens at route1-start, bookmark kept, the
      nested choice reached, reload resumes the newer place, a folder
      with no storyId keyed by its URL, no errors; removing the reload
      guard or the seeding fails them); scratch and bundle tests;
      test_check for `--library`; the wheel test imports the installed
      path from outside the repo and opens the demo seeded on Chrome and
      WebKit with its own `KINETIC_HOME`. Subagent: npm test 1882 (3
      timing tests failed once at load 46, passed on rerun); check
      clean; creator 43/43 Chrome and WebKit; test_check, kinetic_cli,
      paths 74; test_build_wheel 9. Orchestrator, load 33-36 (another
      checkout's WebKit walk): npm test 1882/1882, check clean; creator
      43/43 Chrome, 43/43 WebKit; test_build_wheel, test_check,
      test_paths, test_kinetic_cli 83 passed.)
- [x] The release's checklist in the wheel (item 5). progress.md and
      CHANGELOG.md shipped; `kinetic release-status [--json]`.
      (2026-11-20: build_wheel copies docs/progress.md and CHANGELOG.md
      to `kinetic_extract/data/release/` with `build.json` (`commit`,
      `clean` from `git status --porcelain`, untracked files counting,
      ignored ones not). New `release_status.py`: `kinetic
      release-status [--json]` prints the version, the commit (`-dirty`
      when not clean), checked and open `- [ ]`/`- [x]` boxes at line
      starts, and the CHANGELOG entry for the version; JSON adds
      `commitError` and `source`. A checkout asks git, which must see
      the checkout as its top folder (else commit null with a reason);
      an older wheel missing the files exits 1, bad arguments 2.
      packaging.md and CREATE.md ("Installing Kinetic", "Upgrading to a
      newer Kinetic": gate on `open` 0 offline). Subagent's calls: the
      wheel test compares subcommand names as test_kinetic_cli does,
      since `release-status` wraps argparse's help column; build_wheel
      warns and writes nulls when git cannot answer. Tests: 20 in
      test_release_status.py (boxes, continuation and mid-line `[x]`,
      entries, clean, dirty, unreadable git, no git, nested repo, wheel
      data, older wheel, bad arguments); the wheel test matches the
      installed `--json` to the checkout's, HEAD and the dirty mark.
      Subagent: release_status and kinetic_cli 57; build_wheel 10.
      Orchestrator: the three files 67 passed; this checkout prints 391
      checked and 3 open, as grep counts.)
- [x] The build record ends lines with LF (item 5b, from the closer's
      full pytest). `build.json` written with `newline="\n"`.
      (2026-11-20: `write_build_record` passes `newline="\n"`; the LF
      test flags no other writer. Subagent and orchestrator:
      test_lf_output and test_release_status 19 passed.)
- [x] Docs and package-proof (item 6). AGENTS.md, packaging.md,
      CREATE.md, CHANGELOG; the wheel stage exercises items 3 to 5.
      (2026-11-20: AGENTS.md Commands gain `release-status`, upgrade's
      `--to` and `--dry-run`, `savedState`, `storageKey`,
      `savedState()`, `check --library`, the test-only
      `KINETIC_TEST_SYSTEM_LANGUAGES` and `KINETIC_SCRATCH_DIR`; the
      wheel line names the library and the release files.
      packaging.md: the wheel measured at about 5.0 MB, 92 files, with
      its parts, and the new proof steps. CHANGELOG 1.13.0-dev: five
      bullets, no Upgrading bullet. CREATE.md: "Upgrading" said
      release-status printed the upgrade's lines; now "`kinetic
      upgrade` prints". package-proof's wheel stage gains four steps:
      release-status `--json` equal to the checkout's and HEAD;
      `upgrade --dry-run` (plain and with `--to`) leaves the extract
      demo unchanged; `upgrade --to` links all 12 media, the copy
      validates and its Mac app passes `codesign --verify --strict`; a
      script under `.tmp/` with no puppeteer-core above it imports the
      `--library` path and opens the demo seeded on Chrome and WebKit.
      Subagent's calls: `KINETIC_SCRATCH_DIR` listed as a tool override,
      not test-only; the seed is the record the first open saved, as
      the extract demo's ids are not fixed. Subagent: package-proof
      32/32 (a first run failed its own guard on the repo root's cache
      `node_modules`, narrowed to puppeteer-core); release_version and
      release_status 27; build_wheel 10; npm test 1882, check clean.
      Orchestrator: package-proof 32/32 at load 5-13, both engines
      reopening at line-002 with no errors.)
- [x] Phase-closer (Phase 58): full suites; VERSION 1.13.0, the
      CHANGELOG dated, tag v1.13.0, `main` fast-forwarded, the wheel
      attached to the GitHub release, the Pages demo republished.
      (2026-11-20 on 281354c, load 13-44 from another project's Swift
      builds and a converting agent's Chrome checks: full pytest
      converter and tools 2077 passed, 1 failed, test_lf_output on
      build_wheel's new `build.json` writer (item 5b, fixed; 19 passed
      after); apps/voice 114; Go test and Windows vet clean; npm test
      1870/1882 with 12 vitest timeouts (5000 ms), then 1882/1882 at
      load 8-9; check clean; full `npm run verify` 4312/4326 on Chrome,
      the 14 fails all timeouts (uilanguages waits, audio and
      videosound sync), then uilanguages, videosound and audio 5491/5494
      at load 22, and videosound and audio `--jobs=1` 98/98 at load 6;
      `npm run verify -- --webkit` 6705 pass, 5 partial (the headless
      fullscreen checks), 0 fail; package-proof 32/32; test_build_wheel
      and test_lf_output 14 after item 5b. Docs current: README's
      install line names v1.13.0, CREATE.md's `--version` example
      1.13.0; no screenshot shows anything this phase changed. VERSION,
      package.json, its lockfile and pyproject 1.13.0; the CHANGELOG
      entry dated; tag v1.13.0; `main` fast-forwarded; the wheel built
      and attached to the GitHub release v1.13.0 with the CHANGELOG
      entry as notes; the Pages demo republished from the release
      commit.)

## Phase 59: Link all of media/ in a staged copy (2026-11-21, converting agent)

- [x] `kinetic upgrade --to NEW --link-media` (docs/plan.md Phase 59,
      item 1). Every file under `media/` hard-linked; counts and sizes
      in the copy line; the hint without the flag; docs and
      package-proof.
      (2026-11-21: `--link-media` links every regular file under
      `media/`, named or not, with the named media elsewhere as before;
      symbolic links stay links; a `media` that is itself a symbolic
      link counts as no `media/`. Without `--to` it exits 2 ("works only
      with --to NEW; nothing written") before any other check. The copy
      line now always reads "N files (S) hard-linked and M files (S)
      copied" (decimal units, one decimal place, thousands separators);
      without the flag a second line counts unnamed files under media/
      that were (would be) copied and names `--link-media`. A failed
      link still stops the copy; docstring, CREATE.md "Upgrading to a
      newer Kinetic", AGENTS.md, a CHANGELOG bullet and packaging.md's
      proof list say so. package-proof gains a wheel step running
      `--to --link-media` on a copy of the assembled demo with an
      unnamed file under media/ (shares the inode; counts match a
      walk). Subagent's calls: symbolic links count as copied, sized by
      lstat; the old "media files ... other files" wording is gone for
      every `--to`. Tests: 23 new or changed in test_upgrade_folder.py
      (failing first): inodes with and without the flag, the hint and
      its singular, no hint when nothing is unnamed, no `media/`, exit 2
      leaving the tree unchanged, an injected link failure leaving no
      NEW or temporary folder, size format. Subagent:
      test_upgrade_folder 74; with kinetic_cli and lf_output 119, 1
      skipped (before rebuilding player/dist); npm test 1882, check
      clean; package-proof 33/33. Orchestrator: the three files 120
      passed; on an assembled demo with a 300 kB unnamed file under
      media/, the dry run and real run printed the hint, the copy
      without the flag got a new inode and with it the source's, and
      `--link-media` without `--to` exited 2.)
- [x] Phase-closer (Phase 59): full suites; VERSION 1.14.0, the
      CHANGELOG dated, tag v1.14.0, `main` fast-forwarded, the wheel
      attached to the GitHub release, the Pages demo republished.
      (2026-11-21 on c3574b4, load 6-32 from the suites themselves,
      Spotlight indexing and a converting agent's Chrome checks: full
      pytest converter and tools 2099 passed; apps/voice 114; Go test
      and Windows vet clean; npm test 1882/1882; check clean; full
      `npm run verify` 6635/6635 on Chrome; `npm run verify --
      --webkit` 6703 pass, 5 partial (the headless fullscreen checks),
      2 fail, both videosound's stray-video seek with 155-200 ms
      frame gaps at load 24; videosound `--webkit --jobs=1` then 30/31
      at load 6-7 (the unlock check saw one seek after the key, the
      agent's Chrome at 127%), then 31/31 at load 3.5-6;
      package-proof 33/33. Docs current: README's install line names
      v1.14.0, CREATE.md's `--version` example 1.14.0; no screenshot
      shows anything this phase changed. VERSION, package.json, its
      lockfile and pyproject 1.14.0, test_release_version 12 passed;
      the CHANGELOG entry dated; tag v1.14.0; `main` fast-forwarded;
      the wheel built and attached to the GitHub release v1.14.0 with
      the CHANGELOG entry as notes; the Pages demo republished from
      the release commit.)

## Phase 60: Choices that jump, content that follows a choice, ATL animations (2026-11-26, converting agents)

- [x] A reload at an open choice shows the choice (docs/plan.md Phase
      60, item 1). The overlay drawn from the current state at mount;
      the other listeners checked; scenario parts on Chrome and WebKit.
      (2026-11-26: `main.ts` names the overlay's listener `syncChoice`,
      subscribes it and calls it once with `machine.getState()`, as
      render/app.ts does for the stage; the comment that a resume never
      reopens a decision, wrong since `reopenChoice`, rewritten. No
      machine change: the play-all countdown already restarted at a
      reload and picked with nothing on screen. Listeners checked:
      `persistQuietly` draws nothing; routes.ts and segmentnote.ts read
      their values at mount and show nothing at load by design;
      audiorules.ts and trace.ts already sync at mount; the voice and
      host-link subscribers are not machine listeners. Tests: two
      branches parts on a nine-item folder built at run time, Play all
      routes off (reload and reopen with `savedState`: the choice open
      over the `after` item, Space and Enter leave it open, `1` enters
      route 1) and on (open, its countdown picks route 1 unaided, no
      sooner than 2 s), no console errors; the four reload and reopen
      checks failed first on Chrome and WebKit (73/77). Subagent:
      branches 77/77 Chrome and WebKit, npm test 1882, check clean,
      smoke 6/6, playall 29/29, choicelist 11/11, continueroute 8/8,
      menus 11/11. Orchestrator: npm test 1882/1882, check clean, smoke
      6/6, branches 77/77 on Chrome and 77/77 on WebKit at load 11-23.)
- [x] Lines indented with non-breaking spaces (item 2). The tl reader
      and the script parser read indentation as Ren'Py's lexer does.
      (2026-11-26: Ren'Py's lexer (8.4.2 and 8.5.0 read in the corpus,
      7.6.3 compared) takes a line's depth from its leading U+0020 only,
      then `skip_whitespace` (`\s`, Unicode under Python 3) skips any
      other leading whitespace when the statement is read, which is why
      8.x reads such lines; counting U+00A0 as depth would wrongly nest
      a line under its sibling. The tl reader now matches: depth from
      leading spaces and tabs, then the rest of the leading whitespace
      stripped (`grouped_lines`); `_Cursor.ws` skips any `isspace()`
      character; the original-line comment scan ends a block at a line
      with no leading space or tab. The `.rpy` parser already took depth
      from spaces and tabs and stripped content with `strip()`; only
      `_scan_settings`' top-level label test (`isspace()` on the first
      character) took a U+00A0 line at column 0 as indented, breaking a
      local label's assignment scope, now fixed. Ren'Py quirks not
      copied: its speaker regexp keeps a trailing U+00A0 in the name, and
      a line of only U+00A0 is its lexer's "empty line" error. Tests: a
      CRLF tl block with mixed spaces and U+00A0 (say, narration with a
      trailing U+00A0, an old/new pair) gives its texts (failed first
      with `texts=[]`); source ids of a body indented that way equal the
      plain ones (failed first); a script written with U+00A0 and CRLF
      parses to the same events, menus, reports and assignments as with
      spaces (the scope part failed first). Subagent: parser and tl test
      files 129 passed, converter and test_translations 1172 passed.
      Orchestrator: test_parser, test_renpy_translations and
      test_translations 171 passed.)
- [x] Script lines split as Ren'Py splits them (item 2b, a lead from
      item 2). `parse_file` splits with `str.splitlines()`, which also
      breaks on `\x0b`, `\x0c`, `\x1c`-`\x1e`, `\x85`, U+2028 and
      U+2029; Ren'Py breaks only on `\n`, `\r` and `\r\n`, so such a
      character inside a line splits it and shifts line numbers (and the
      translation ids made from them). Split as the tl reader does.
      (2026-11-26: parser.py gains `renpy_newlines` (BOM dropped, `\r\n`
      and `\r` made `\n`) and `script_lines` (split at `\n`, a final
      empty line dropped, so ordinary input splits as before); every
      script reader uses them: `parse_file` and
      `creator_statement_names` (were `splitlines`), the tl reader's
      `logical_lines` and `_read_tl_file`'s physical lines (same
      behaviour, one helper); rpyc.py's text goes through `parse_file`.
      Left as they are, none splitting script text: po.py, the media
      tools' checksum and output text, posters.py's id list, subprocess
      output in app_hosts, assets and release_status, apps.py's licence.
      Tests: per character (`\x0b`, `\x0c`, `\x1c`-`\x1e`, `\x85`,
      U+2028, U+2029) a dialogue line keeps its text at its line and the
      next lines their numbers with CRLF and lone CR mixed in (8 cases),
      and the tl identifiers match those lines' blocks (8 cases); all 16
      failed first (the parser's shifted sources missed their
      translations). Subagent: converter and test_translations 1188
      passed. Orchestrator: test_parser, test_renpy_translations,
      test_rpyc and test_translations 192 passed.)
- [x] A one-choice menu keeps its line (item 3). The choice text a
      narration line in place, its translation from `strings`.
      (2026-11-26: parser.py's `_one_choice` takes a menu block of an
      optional caption line and exactly one plain `"text":` choice;
      `_handle_menu` then emits the caption (a `menu "x":` head's too)
      and the choice text as speakerless dialogue marked
      `from_strings`, and resumes the main scan inside the choice block,
      so the block is label flow (jumps, calls, `$`, audio, scene/show)
      with no second reader; no MenuRecord, no report, a named menu
      still makes its label. timeline.py records those parts'
      sources (`ItemRecord.string_sources`) and translations.py's
      `_take_strings` gives them their language's `strings` `new`
      text (`norm_key`, as route labels), counted in "strings used". A
      conditional lone choice still reports `fewer than two choices`.
      Subagent's calls: the caption is a line of its own before the
      choice (Ren'Py shows it with the menu); no ledger note, left to
      item 4. Tests: test_one_choice_menu.py (the line in place with
      the block after it, `$` assignment and `$ renpy.jump`, a caption,
      a named menu, the conditional case unchanged, the walk following
      the block's jump; an extract with a de strings block: items in
      order, no branches, both lines translated with the right `from`,
      5 of 5 strings used, coverage 8 of 8, validate --strict silent);
      6 of 7 failed first, the unchanged-case test passing as meant;
      test_branch_extract's lone-choice reject now uses a conditional
      choice. Subagent: the touched files 163, converter and tools 2138
      passed. Orchestrator: those files with test_translations 205
      passed.)
- [x] Menus whose choices jump become decisions (item 4). Routes from
      the walk's alternatives, results proven from how each path ends;
      empty choices get their text; in-place menus get their joins.
      (2026-11-26: parser.py's statement scan is now `_scan_lines`, so
      each choice block of a menu of two or more plain choices is read
      as label flow into its own events (lines, audio, nested menus, `$`
      lines, the closing jump, call or return); the menu is one `fork`
      event carrying its MenuRecord and the bodies, and MenuRecord
      keeps each choice's `$ x =`/`+=`/`-=` assignments for item 6.
      Still rejected as before: a conditional choice, a `label` in a
      choice block, a statement before the first choice, other lines
      between choices, a lone conditional choice. flow.py's
      `_menu_join` takes the fork's post-dominator when it lies outside
      every choice block, else the node most choices' post-dominator
      chains share (loops back to the menu left out); `run` lays the
      menu out as markers around each choice's path and the join once,
      and classifies each path's end: join, back at the menu (its label,
      a named menu, or a label reaching it with no story between),
      exit, a rejoin elsewhere, or not followed. timeline.py nests menus
      (`menu_stack`), takes `continueAt` from the first item after the
      region, and `finish_candidates` sets the continuing route (the
      last `"continue"` one), gives a nested decision whose join is its
      parent's the parent's `continueAt`, and makes a decision with no
      join item a pure choice. audio_cues.py's CueWalker keeps a stack
      of enclosing menus' states. cli.py emits each route's `result`,
      `continuingRoute` and `continueAt`, moves a dropped `continueAt`
      to the next kept item (else a pure choice), and the
      `branchDetection` note gives each route's result and its proof.
      An empty choice gets its text as a line from `strings`; a menu of
      empty choices stays linear. extracting.md's walk section.
      Subagent's calls: every decision menu goes through the walk, so an
      unknown statement in a choice block is reported as in a label,
      not a reject, and a nested menu is a nested decision; a choice's
      `return` counts as the story's end even inside a called label (a
      documented limit); a jump back to a label with a line before the
      menu is a rejoin (item 4b takes it up); a choice ending the story
      beside one jumping on still gets a join. Tests: test_jump_menus.py
      16 end-to-end cases (two rejoining choices, three with `$` lines
      and lines before the jumps, a refusal to the menu's label and to a
      named menu, three-deep nesting, every choice to one label, a
      story-ending choice, a `call`, an empty choice with its de
      strings translation, a rejoin into another choice's content, an
      in-place menu falling through, a menu at the story's end, a
      conditional choice, a menu straight after a menu, a route item
      dropped by the asset pass), each validating --strict silent,
      `kinetic routes --json` counts matching, and `kinetic check
      --steps all` reaching the end with exit 0 (play-all plays every
      route); 14 failed first, the story-end case passing as meant, the
      asset-pass case shown failing with its fix off; an audio test of a
      menu nested in a route. Changed expectations: the renpy_demo
      golden (its second menu is now a decision with a line kept that
      was dropped, ids after line-012 shifted by 2, the first menu now
      continuing), test_branch_extract (2 detected, fork-body tests),
      test_flow, test_audio_extract, test_parser, test_pipeline,
      test_audio_ship, test_renpy_translations (de coverage 15/33),
      test_episodes. Subagent: touched files 281, converter and tools
      2179, npm test 1919. Orchestrator: converter and tools 2179
      passed. On a reporting agent's game (read-only, a parse-only walk
      outside the repo): 61 menus noted, 35 decisions (60 routes
      `"continue"`, 7 `"ending"`, 6 `"return"`, 32 with `continueAt`),
      26 linear: 3 with every choice empty, 23 rejoining content another
      route read: mostly a shared tail that many nested choices jump
      to (docs/future.md, "Routes that share a tail"), and choices
      jumping back to a label that reaches the menu through lines or a
      screen (item 4b).)
- [x] A jump back through the menu's lead-in is a return (item 4b, a
      lead from item 4). A choice whose path jumps to a label that
      reaches its menu by straight-line story (lines, shows, audio, no
      fork or other flow), re-reading the decision's lead-in, is a
      `"return"` route, not a rejoin.
      (2026-11-26: flow.py's `leads_to` is now `way_to_menu`: None when
      the op does not reach the menu fork, "" with no story on the way
      (item 4's case), else the source of the first story event passed,
      the lead-in's start; after a story event only straight-line ops
      may follow (story and other emits, labels falling through, the
      `goto` ending a block), and a jump, call, return, fork or file end
      gives None. The route's note reads "jumps back to the menu
      through its lead-in at <source>"; the nested-menu check uses the
      same function; the step cap is 5000. extracting.md's jump-menu
      paragraph updated. Subagent's calls: the source named is the
      lead-in's first story event (a `show` may come first); a jump
      chain with no lines is "return" as before, a jump after a lead-in
      line a rejoin. Tests (test_jump_menus.py): the refusal through one
      lead-in line (the lead-in not laid out again, the note), through a
      `show`, `play music` and three lines, a nested menu's refusal, all
      failing first; an `if ...: jump` and a `jump` on the way back stay
      rejoins (guards, passing before too); each decision case checked
      by validate --strict, routes counts and `kinetic check --steps
      all`. Subagent: jump menus, flow and branch extract 59; full run
      2201 with item 8's unfinished test file deselected (a
      test_decision_scale timing failure at load 41 passed alone).
      Orchestrator: converter and tools 2201 passed with item 8 in the
      tree.)
- [x] A decision that follows an earlier one (item 5). `follows` and
      `when` in the format, validator, player and tools.
      (2026-11-26: types.ts `Branch.follows`, `Route.when`; machine.ts
      resolves each following decision (`resolveFollows`, `takesFor`:
      the route that takes each followed route, an unsound table leaving
      an ordinary decision) and `fireDecision` enters the match as a
      pick (pill shown) or passes on to `continueAt`; `nextAutoRoute`
      plays the match last under play-all; `pickFor` (the wheel's walk)
      follows the match where the decision has no pick of its own;
      `forwardOf`/`backwardOf` step a passed decision from `after` to
      `continueAt` and back; skip carries on through an entry or a pass
      and stops before an unseen target; `u` reads the target as Space's
      continuation; `decisionPassed` counts a pass once `continueAt` is
      read. Validator `following_problems` (content-format rules 26 and
      27), schema entries, folder_model's `_resolve_follows` mirroring
      the player, `kinetic routes` (outline, JSON `follows`/`passesOn`/
      `when`, DOT edges) and `kinetic export` (which pick each row
      takes), a route-shapes case (map counts unchanged), content-format
      Branches, player.md's Decisions, a CHANGELOG bullet. Subagent's
      calls: a following decision with a pick no route takes needs
      `continuingRoute`/`continueAt` (else the validator reports it and
      the player ignores `follows`); a bad `follows` is one problem, its
      `when`s unchecked; the match is entered even when every route was
      played this pass (the follow check runs before the pure-choice
      close); under play-all the continuing route's end re-offers while
      a route is unplayed when the match is not that route; the wheel
      still shows the decision's choice screen, highlighting the match,
      so the other routes stay reachable with Play all routes off; the
      branch map, check-game and the testing library unchanged (a
      check-game walk of the scenario folder visited all 15 items).
      Tests: follows.test.ts 24 (19 failed first, 5 guard unchanged
      behaviour); validator 18 (14 failed first, the rest valid cases);
      routes +4 and export +1 failing first; follows.scenario.mjs
      (matched, passed, unknown, playall), 5 checks failing on HEAD's
      machine and the no-pick check passing there, so an older player
      shows an ordinary choice without errors. Subagent: npm test 1919,
      check clean, smoke 6/6, follows 10/10 Chrome and WebKit, the six
      decision scenario files 201/201 Chrome, Python 607. Orchestrator:
      validator, routes, export and report 568 passed; npm test
      1919/1919, check clean, smoke 6/6, follows 10/10 on Chrome and
      10/10 on WebKit, branches, playall, continueroute, choicelist,
      branchmap and menus 201/201 on Chrome, at load 31-40.)
- [x] Conditions become decisions (item 6). `follows` decisions,
      counter ranges and choice-named labels in every interface
      language; `--condition-names`; the report's section.
      (2026-11-27: new conditions.py. `parse_project` scans every file's
      assignments first; at each `if`, `_handle_chain` asks
      `conditions.read_chain` whether the chain is readable (one
      variable throughout; bare name, `not`, `==`, `!=`, `<`, `<=`,
      `>`, `>=` on whole numbers when every literal given the variable
      is one, `in`/`not in`, `is` True/False/None, `store.x` as `x`;
      not `persistent.`, `renpy.`, `config.`, `preferences.`, `_`
      names, variables only Python sets, or a `label` in an arm). A
      readable chain is a MenuRecord with `.condition` and a fork whose
      bodies are the arms read as label flow (an absent `else` an empty
      arm), laid out by item 4's walk and timeline; an unreadable one
      reports once on its `if` line ("if chain not converted (<why>)")
      and keeps the old `_chain_fork`. `conditions.prepare` gives each
      chain its kind before the walk: follows (all assignments but one
      default literal `=` in one menu's choices, each choice taking the
      first arm its value passes), ranges (whole-number intervals on a
      counter), words (the rest); it drops arms no value takes ("if arm
      never taken"), reads a one-arm chain in line, and writes the base
      language's prompt and labels. The timeline follows the menu's
      candidate when it is closed before the chain (else an ordinary
      decision with the same labels); cli.py writes `follows`/`when`,
      makes the chain ordinary (or withdraws it) when its followed
      decision is withdrawn, withdraws one that would pass with no
      `continueAt`, and gains `--condition-names` (a malformed file
      exits 2, an unknown key warns). The 14 phrases are
      `converter.condition.*` keys in player/src/i18n/en.ts;
      `npm run i18n` writes converter/condition-words.json (stale fails
      `npm test`; the wheel carries it; `paths.CONDITION_WORDS_FILE`);
      `auditLocale` skips the untranslated `converter.*` keys until item
      6b. Language files get each language's words, with choice text
      from its `strings` block; `match_tag` follows the player's rule.
      The ledger gains `conditions` and notes "from a condition on X,
      kind K"; `kinetic report` a "Decisions made from conditions"
      section (text and JSON) naming languages that fell back to
      English; a `conditions:` summary line. extracting.md
      "Conditions", CREATE.md, AGENTS.md, verify-player.md,
      converter/README.md, a CHANGELOG bullet. Subagent's calls: extra
      phrases "{name} exactly {n}", "{name} {low} or {high}" for two
      adjacent numbers ("to" from two apart), "{first} or {second}",
      "{name} is {value}"/"is not {value}" so every readable chain is
      worded, "({label})" translatable; the words file lives at
      converter/condition-words.json (build_wheel refuses a checkout
      `data/`); a follows decision needs two routes, so a one-arm
      chain's absent `else` some choice takes stays a route with its
      `when`; dead arms are dropped with their lines (faithful to the
      game); the empty arm's line is its label in parentheses. Tests:
      test_conditions.py 50 end-to-end and unit (follows with and
      without `else`, `!=`/`in`, a dead arm, arms jumping before
      rejoining, audio in an arm, a chain in a route and in the menu it
      reads, three ranges and range wordings, flags set in two menus
      and in label flow, five unreadable kinds, a French base game with
      en and de files on a test catalogue, per-language names, a base
      language the catalogue lacks, the names-file warning and four bad
      files, `match_tag`, range arithmetic, `read_test`), all failing
      first; two i18n.mjs tests; test_parser's U+00A0 test expects 2
      menus. Subagent: converter and tools 2267, npm test 1921, check
      clean. Orchestrator: converter and tools 2267 passed; npm test
      1921/1921, check clean. On a reporting agent's game (read-only
      parse-only walk with `prepare`): 60 decisions (from 35), 114
      `"continue"`, 25 `"ending"`, 6 `"return"` routes, 1,300 more
      items (lines in chain arms now kept); but 0 `follows`: 22 chains
      became ordinary "If you chose" decisions because the game resets
      each variable in label flow (`$ x = ""`) before the menu that sets
      it, which the follows rule refuses: item 6c.)
- [x] An initial value set in label flow (item 6c, a lead from item 6).
      A literal assignment reached before the menu, outside every menu
      and chain, is the variable's value for routes that set nothing,
      as a `default` is.
      (2026-11-27: parser.py adds a `set` event for a top-level `$ x =
      ...` in label flow; `flow._program(sets=False)` and the file-order
      walk leave them out, so the walk, joins and timeline are
      unchanged. New `flow.Resets` builds the program with them as a
      graph run the way Ren'Py runs (a jump to its label, a call into
      its label and past it, a computed one to its named labels and
      every label a literal names, a return or file end nowhere);
      `values_before` counts a reset only when it is reachable from the
      start and leads to the menu, none is reachable from the menu (a
      return or file end also going back past each call whose callee
      leads to the menu), and the values reaching the menu on every
      way come down to one (a way passing none giving the default).
      conditions.py's `prepare` gains `start_label` (cli.py passes
      `--label`), builds Resets once and lazily, and `_followed`/
      `classify` take its answer; every doubt gives a words decision.
      Subagent's calls: the graph, not one walk's visit order, since a
      walk visits each line once and cannot see a reset running again
      after the menu or two ways setting different values; a choice
      that sets the variable and loops back to the menu is still not
      tracked (item 6's limit); the branchDetection note does not say
      the start value came from a reset. Tests (test_conditions.py,
      each through check_folder): a reset before the menu (the choice
      that sets nothing takes its arm), several resets taking the last,
      a reset in an earlier label reached by a jump, all failing first;
      a second reset after the menu, a reset in another menu's choice,
      resets differing on the way, a reset in a loop that runs again
      after the menu, all staying words (guards, each shown to turn
      `follows` without its cause in a probe outside the repo); item
      6b's German label read from the words file, the French test's
      comment corrected; test_one_choice_menu's helper skips `set`
      events. extracting.md, CREATE.md, converter/README.md, the
      CHANGELOG bullet, the module docstring. Subagent: converter and
      tools 2274. Orchestrator: converter and tools 2274 passed; on a
      reporting agent's game (read-only parse-only walk) 65 decisions,
      16 of them `follows`.)
- [x] The condition phrases in every interface language (item 6b, item
      6 split in two). Every PO file translates item 6's phrases; the
      converter's file regenerated; a test that every language has them.
      (2026-11-27: the 14 `converter.condition.*` messages translated
      in all 38 PO files with the pot's translator comments, every
      placeholder kept, each file's conventions followed (formality as
      its "your last pick" entry, French no-break spaces and curly
      apostrophes, `¿…?`, `؟`, Greek `;`, full-width `：` and `（）` in
      zh-Hans, zh-Hant and ja, es "Si has elegido", es-419 "Si
      elegiste"). Subagent's calls: `set`/`notSet` as "{name}: yes"/
      "{name}: no" in every language (a literal "is set" would agree
      with a name's unknown gender and reads as jargon); `is`/`isNot`
      by the language's copula where it does not agree, else a colon or
      dash form; word order per language for ranges (ja `以上`/`未満`,
      ko `이상`/`미만`, tr `veya üzeri`/`altında`, hu and fi `{low}–{high}`),
      ranges inclusive at both ends; ja quotes the choice
      (`「{choice}」を選んだ場合`). i18n.mjs's `auditLocale` no longer
      skips `converter.*` (the existing placeholder-set check covers
      them); `npm run i18n` regenerated locales.generated.ts,
      apps/host-words.json (digest) and converter/condition-words.json
      (messages.pot unchanged). Tests: the exemption test removed; new
      tests that a blank or placeholder-changed converter phrase is
      reported and that the shipped words file gives every language
      every phrase with the English placeholders. verify-player.md and
      extracting.md updated (the latter committed with item 6c).
      Subagent: npm test 1922, check clean, test_build_wheel 10,
      test_conditions 57 with 1 failing on the old English German label
      (fixed in item 6c's file). Orchestrator: npm test 1922/1922, check
      clean; de, fr, ja, ar and ru phrases read in the words file.)
- [x] Animation timing (item 7). `frameSeconds` and `holdLastFrame` in
      the format, validator, player and tools.
      (2026-11-26: types.ts's AnimationItem gains both fields;
      machine.ts's `animationFrameSeconds` (the list only when it fits:
      one finite number above 0 per frame, else null and even timing),
      `animationLoopMs` (their sum, else frames over `fps`) and
      `animationStillFrame` (the last frame on a text item after a held
      animation, else `frames[0]`); `itemHoldMs` loops by
      `animationLoopMs`. visual.ts times the run per frame
      (`animationStepAt`, `animationFrameAt` a wrapper keeping the even
      step math), and a held animation runs as fixed loops even in a
      chain, so the run carries on under its lines and stops on the
      last frame; stills on those lines show it, and bookmarks.ts's
      fallback thumbnail there too. Schema: `frameSeconds` an array of
      numbers above 0, `holdLastFrame` a boolean; the validator's
      `animation_timing_problems` checks the length (content-format
      rule 25); report.py's loop time sums `frameSeconds` when they fit.
      folder_model, export, apps, posters and the testing library read
      frames only: unchanged. content-format.md (Items, Text items,
      Timing, rules 4 and 25), CREATE.md's manifest reference,
      verify-player.md's media row, a CHANGELOG bullet. Subagent's
      calls: a line reached with no run under way (a forward advance
      after a still, a reload at a line, a route entry) shows the last
      frame and plays nothing; the animation's own item still shows
      `frames[0]`; ill-fitting `frameSeconds` fall back to `fps` in the
      player and report; the scenario's tolerance is 100 ms per change,
      under one 4 fps step. Tests: 12 vitest (frame steps, the layer on
      fake timers: timing, the held frame under the next line, looping
      without the field, stills on rewind, skip and `e`, a line with no
      run, a standalone held animation; hold times; the thumbnail), all
      failing first; 12 validator tests (10 failed first, the 2 on a
      non-animation item already refused by the schema); a report test
      failing first; media's `heldFrames` part (frames at 0/300/900/1200
      ms within 100 ms, the run going on under a line pressed mid-run,
      the last frame held 1.8 s on; no swaps on the next line, the last
      frame on a rewound line, `frames[0]` on the item), failing on a
      HEAD build. Subagent: npm test 1894, check clean, smoke 6/6, media
      25/25 Chrome and WebKit twice (the second at load 61), validator
      485, report 35. Orchestrator: validator, report and schema-copy
      529 passed; npm test 1894/1894, check clean, smoke 6/6, media
      25/25 on Chrome and 25/25 on WebKit at load 9-25.)
- [x] ATL frame lists become animations (item 8). Frames, pauses and
      `repeat` read; one-frame blocks as stills; lines kept.
      (2026-11-26: parser.py reads an `image name:` block (names with
      attributes too) as a frame list, `image_defs[name] = ("atl",
      AtlImage)`, its `timing()` giving `fps`, `frameSeconds`,
      `loopCount` and `holdLastFrame`: quoted frames, `pause N` or a
      bare number (consecutive ones adding up), `pass`, `animation`,
      `function` (dropped, reported), a frame's `with` (a cut,
      reported), a last `repeat`/`repeat N`, comma-joined statements;
      anything else (motion, `block`, `parallel`, `choice`, `on`,
      `contains`, `time`, `event`, an expression frame, properties over
      several frames, a statement after `repeat`) gives "image without
      a file: ATL statement `...` (<source>) not converted".
      timeline.py's name resolution is `resolve_name` (unchanged), plus
      `resolve_frame` and `atl_pending`: a `show`/`scene` of an ATL name
      is an `animation` item with one image record per frame; a frame
      resolving nowhere drops the item with a reason naming it.
      assets.py's `_ship_animation` ships each frame through the image
      path (shared frames once by digest, a ledger media entry each;
      the item's ledger entry `decision: "frames"` with its frames); a
      frame not shipped drops the animation; cli.py gives frame records
      their project and counts them as media shipped. extracting.md
      "ATL frame lists" and the build ledger paragraph, CREATE.md's
      "Frame-by-frame animations", a CHANGELOG bullet. Subagent's calls:
      a frame with no pause after it shows for no time and is left out,
      reported, except a non-repeating block's last frame, kept as the
      held frame with the block's shortest pause; one picture repeated
      is a still; a one-frame block with motion stays unconverted, with
      plain properties a still ("not applied" reported); animated GIF or
      WebP frames ship as they are; a quoted frame with a dot is a file
      (game/, game/images/, the archives), without one an image name;
      `repeat 0` is not converted. Tests: test_atl_animation.py 17
      (each shape, 12 other-ATL rejections named, a one-frame `zoom`
      still, frames by image name; an extract with the right timing
      fields and the lines kept, shared frames shipped once, validate
      --strict silent, `kinetic check --steps all` to the end, `kinetic
      media rebuild --out` matching every entry; an unresolved frame
      dropping its item), 16 failing first. Subagent: 17 passed; full
      run 2201. Orchestrator: atl, parser and pipeline 51 passed;
      converter and tools 2201 passed. On a reporting agent's game
      (read-only parse-only walk): 445 animations (175 with
      `frameSeconds`, 14 held), 1,315 lines more kept (text items 15,934
      to 16,804 with the animations' own lines), no `droppedUnresolved`
      left in the top reports; 41 frame dissolves and 3 `function`
      lines reported; but 16 menus whose routes now hold an animation
      stay linear ("contains a animation item"), so decisions fell from
      35 to 19: item 8b.)
- [x] Routes may hold any item (item 8b, a lead from item 8). The
      converter's menu check accepts animation and video items inside
      routes, as the format always has.
      (2026-11-26: the rule came from Phase 13.6's conservative
      detection (da4c5ec), caution rather than a fix; the validator
      only requires a route's first item not be `text`. timeline.py's
      `close_menu` type check is gone. Lifting it exposed a visual bug,
      fixed: a later route starting with a line got a `text` item, which
      the player (`visualIndexFor`, array order) showed over the
      previous route's last visual, not the menu's; now, when an earlier
      route has shown another visual since the menu, the route's first
      line goes on a repeat of the menu's visual (a picture as itself,
      an animation playing again, a video from its start with its
      sound; a held animation as an image of its last frame), never with
      a transition, dropped when the route starts with a visual of its
      own, not counted again in the size probe, its ledger note "repeats
      the visual on screen at the menu at <source>". Checked and fine:
      audio cues after a route's last line attach whatever its type;
      every video item gets its soundtrack; the converter writes no
      `segments`; a dropped route video withdraws the decision. cli.py's
      simplification note, converter/README.md's menu bullet,
      extracting.md's Menus bullet, a CHANGELOG bullet. Subagent's calls:
      the repeat follows what is on screen, not item positions; a repeat
      with no line on it is dropped; repeats stay in a menu kept linear.
      Tests: test_route_items.py 7 end-to-end (a route showing an ATL
      animation; a route playing a video with `videoSound` and an sfx;
      a route's first line over the lead-in's looping animation, over a
      held animation, over a video with a dissolve; pictures only; a
      dropped route video withdrawing the decision), all failing first,
      each validate --strict silent, routes counts, `kinetic check
      --steps all` to the end. Subagent: the branch, ATL and menu test
      files 98; converter and tools 2208. Orchestrator: route items, jump
      menus, branch extract, ATL, one-choice, malformed branches and
      pipeline 113 passed; on a reporting agent's game (read-only walk)
      decisions back to 35 (60 `"continue"`, 7 `"ending"`, 6
      `"return"`) with its 446 animations kept, no menu refused for an
      item type. Leads: item 8c; the join's first line showing the last
      route's visual, docs/future.md "The visual at a join".)
- [x] A route that opens with a nested menu (item 8c, a lead from item
      8b). The nested decision hangs off the item before the route, so
      the join's line is never shown (`validate --strict` exit 3).
      (2026-11-26: flow.py emits the enclosing choice's text as a
      `choice-text` marker (item 4's `from_strings` mechanism) before
      every menu nested in a choice's path, a `route-lead` once the
      nested menu is a decision, in the file-order walk too;
      timeline.py's `route_needs_lead` makes it a narration line only
      when the enclosing route has no item yet and no visual waiting, so
      item 8b's repeat gives it the menu's picture; a new `close_menu`
      guard keeps a nested menu whose `after` lies before its route
      linear ("no item of its enclosing route precedes the menu").
      A related bug fixed: a nested menu falling through at its route's
      end met at the block's `goto` and became a pure choice of
      `"ending"` routes (a reader with Play all routes off had to read
      every inner route); now `enclosing_join` counts that as the
      enclosing menu's join, so its routes continue to the enclosing
      `continueAt`; `path_end` follows a `goto` another path passed.
      extracting.md's Menus and linear cases. Subagent's calls: the line
      is added whenever a nested decision would otherwise have no
      `after` in its route (a jump or call straight to a label opening
      with a menu too), decided by the timeline from what it emitted; a
      bare visual before the menu still serves as `after`; a route whose
      lines drop with an unresolved visual gets no line (the guard keeps
      the menu linear); a menu at the end of an `if` block keeps its old
      behaviour. Tests: test_route_opens_with_menu.py 8 end-to-end (route
      1, a later route with the repeated picture, two deep, a jump to a
      label opening with a menu, de strings translations of the line,
      prompts and labels, file order, a line before the menu with inner
      routes now `"continue"`, the guard), 6 failing first, 5 failing
      with the guard and join fix removed; test_flow's nested-menus test
      now expects the Right route's line and the inner decision inside
      it. Subagent: converter and tools 2216. Orchestrator: converter and
      tools 2216 passed; a reporting agent's game (read-only walk)
      unchanged at 35 decisions.)
- [x] Fixtures and docs (item 9). The extract demo covers the new
      shapes; package-proof.
      (2026-11-27: fixtures/renpy_demo's script ends with a nightcap
      scene: `$ drink = ""` in label flow, a menu at `label ask_drink`
      ("Tea, please" with no line of its own, "Cocoa" with `$ warmth
      += 1` and a line, "Not yet" jumping back through the lead-in), a
      `drink` chain with no `else` (a `follows` decision that passes on),
      a `warmth` counter chain (2 or more, exactly 1, under 1), and
      `scene candle`, an ATL image of three frames at 0.3/0.15/0.15 s
      with `repeat 2` (`loopCount` 2, held); `default warmth = 0`; the
      first menu's "Warm the room again" adds 1; three 0.3 kB candle
      frames from generate_assets.py's new `candle()`; tl/de gains the
      new lines and strings (comment line numbers after line 48
      shifted). The golden manifest regenerated (HEAD's fixture shown to
      reproduce the old golden first; items 1-22 unchanged, 13 items and
      3 decisions added, `menu-start-62` now 63); test_branch_extract
      (5 decisions, the nightcap's routes, `follows`/`when` and range
      labels, the lead-in note), test_renpy_translations (identifiers,
      de items and the condition words in German, coverage de 38/57,
      zh-Hans 8/57, report counts) and test_episodes' `_prefixed` helper
      (prefixes `follows`) updated. package-proof gains a wheel step:
      the conversion has 5 decisions, one `follows` with every route's
      `when`, one `"return"` route, one held animation with
      `frameSeconds`. Docs: CREATE.md (menus, lines as Ren'Py reads
      them, the demo summary refreshed, routes/export with `follows`,
      the Branches reference's `follows`/`when`, re-conversion for
      1.15.0 in the converter and upgrading sections),
      content-format.md (converted menus and chains carry
      `continuingRoute`/`continueAt`), player.md (held animations; a
      choice left open comes back open), extracting.md (line splitting
      and U+00A0, one-choice menus, `strings` lines), AGENTS.md's routes
      line, converter/README.md, packaging.md (the proof step; the
      extracted demo 27 files, about 1.69 MB), and the CHANGELOG entry
      with bullets for items 1-4b and 8c and an **Upgrading:** bullet.
      Orchestrator's scrub: a name and frame file names taken from a
      reporting game's examples (in the plan, CHANGELOG, CREATE.md,
      extracting.md, test_conditions.py and test_atl_animation.py since
      items 6 and 8) replaced by neutral ones. Subagent: converter and
      tools 2274; npm test 1922 (one mapmodel timeout while pytest ran,
      86/86 alone, 1922 on rerun); check clean; smoke 6/6;
      package-proof 34/34; `kinetic check --steps all` 35 of 35 items.
      Orchestrator: branch extract, translations, episodes, pipeline and
      parser 187 passed; test_conditions 58 and test_atl_animation 17
      passed after the scrub. Lead: item 9b.)
- [x] Ledger notes for condition decisions (item 9b, a lead from items
      6c and 9). The route count in a `follows` decision's note, and
      where its starting value came from.
      (2026-11-27: `finalize_branches` counts the finished decision's
      routes (`len(decision["routes"])`), so every note path agrees
      with the manifest: the demo's nightcap reads "2 routes", the
      counter still 3. `Resets.values_before` returns `(value, source)`
      pairs, the last reset on each way to the menu (None where a way
      passes none); `conditions._followed` keeps `ChainCondition.start`
      (`value`, `resets`, `default`), None with no reset or when every
      choice sets the variable; a `follows` note gains "the choices
      there that set nothing start as "" from the reset at <source>",
      the `conditions` ledger record `startingValue`, and `kinetic
      report` the same line (text) and field (JSON); the wording is
      `conditions.start_sources`, which report.py imports;
      extracting.md describes them. Subagent's calls: every reset that
      is last on some way is named, overwritten ones not; a default
      agreeing on a way with no reset is named too; nothing said for a
      lone `None` reset with no default; only on `follows` decisions
      with a choice that sets nothing. Tests: the demo's notes, a reset
      before the menu (note, `startingValue`, report text and JSON),
      several resets naming the last, a reset and a default named, a
      chain without `else` counting 2 routes, the report JSON's null;
      6 failing first. Subagent: the touched files with report and flow
      132; converter and tools 2275. Orchestrator: branch extract,
      conditions, report and flow 132 passed.)
- [x] A reload at a choice reopened by moving back shows the choice
      (docs/plan.md Phase 60, item 9c).
      (2026-11-27: the fault was in saving: `exportPlace` left `choice`
      out while `pendingChoice.walk` was set, so a choice screen the
      wheel or the branch map walked onto was never written; it now
      writes the open choice however it opened, and `reopenChoice`
      reopens it as a live choice. `Machine.walkedChoice()` keeps the
      trace's `walked` field meaning what it did. docs/content-format.md
      no longer says a walked screen reloads as the item under it.
      Subagent's calls: a reloaded walked screen comes back live (the
      walk's highlighted route is not saved; under Play all routes the
      countdown restarts and picks, as item 1's does); the tests use the
      wheel, since Left only steps video segments. Tests: machine tests
      on a walked screen's save with play-all off and on (both failed
      first), a second notch back staying closed across a reload, a
      route end's re-offer; scenario parts reloadWalkedChoiceManual and
      reloadWalkedChoicePlayAll (both failed first in Chrome).
      Orchestrator: npm test 1925 passed, check clean, smoke 6/6,
      branches 82/82 Chrome and 82/82 WebKit.)
- [x] An animation read again plays again (item 9d).
      (2026-11-27: the machine classed every join as a `nav` arrival:
      `join()` and `closeIfPureAndComplete()` showed `continueAt` with
      `"nav"`, so below the seen edge `playbackModeFor` gave a still and
      the demo's candle, after its decision's join, showed `frames[0]`;
      videos after a join were stills too (a Phase 16.11 default). Now
      `flowTransition(flow)` makes a read step `advance` and a skip step
      `nav`: a route's end at `continueAt`, a following decision passing
      on, play-all's resolve and the all-played pure-choice close; and
      `enterRoute` makes a reading arrival `advance` (a pick on the choice
      screen, play-all's auto-pick on the countdown or Space, a following
      decision's entry on Space). Jumps stay `nav`: a branch-map pick,
      the wheel, bookmarks, `e`, `#start=`, a resume, skip's steps; `u`
      keeps its existing `advance` (it lands on unseen content).
      Decisions: answering the return row (`chooseContinue`) arrives as
      an advance. docs/content-format.md "Timing" and the CHANGELOG say
      so. Tests: machine tests on joins, passing on, the pure close,
      choose(), the auto-pick and the following entry below the seen
      edge (each failed first), skip's step staying `nav`; media
      scenario parts heldReplay, heldJoin and heldRepick (heldJoin and
      heldRepick failed first). Orchestrator: npm test 1932 passed,
      check clean, smoke 6/6, media, branches and follows 123/123 on
      Chrome and 123/123 on WebKit.)
- [x] Shared spans in the format (docs/plan.md Phase 60, item 9e).
      (2026-11-27: docs/content-schema.json gains a decision's `shared`
      (`$defs/sharedSpan`: `id`, `start`, `end`, `result` default
      `"ending"`) and a route's `then`; docs/content-format.md's
      Branches bullet states the reading and rules 28 to 30;
      validate_content.py checks them (`_shared_span_rules`,
      `shared_problems`); folder_model.py carries `Decision.shared` and
      `Decision.thens` and words span problems as the validator does;
      the player's types accept both (behaviour is item 9f). Subagent's
      calls: rule 28 span soundness (ids unique among routes and spans,
      after `after`, disjoint from routes and spans, before
      `continueAt`, `"continue"` needs the join); rule 29 a span holds no
      decision (a scene with its own menu stays each route's content);
      rule 30 `then` names a span of its decision or an enclosing one,
      nearest wins, and the continuing route's `then` only its own
      decision's `"continue"` span; a route leaving through an
      enclosing span leaves its enclosing routes uncompleted; a span
      completed with `"continue"` counts as a completed `"continue"`
      route for the passed rules, the return row still opening only on
      the continuing route's own completion; an older player ignores
      both fields. Lead for 9f: the validator's reach walk
      (`shown_by_play_all`) ignores spans, so their items warn "never
      shown" until 9f ports the span flow there. Tests: 31 validator and
      schema tests and 4 folder-model tests failing first. Orchestrator:
      the validator, assemble, spans, scale, malformed, report, routes,
      export and schema tests 672 passed; npm test 1932, check clean.)
- [x] Shared spans in the player (item 9f).
      (2026-11-27: machine.ts follows a route's `then` into its span
      (`enterSpan`: the route's frame stays on top, the span's decision
      and what it holds closed, a reading entry an `advance`, a skip
      step `nav`) and acts on the span's `result` at its end
      (`endSpan`: the leading route completes; a pure choice all played
      closes past its region, `"continue"` joins or re-offers under Play
      all routes, else the choice is offered again with the return row
      by its rule). Under Play all routes a span is read once per pass:
      it counts as read when another route leading into it is in
      `passPlayed`, and a later route runs a skip burst through it
      (`MachineState.readAgain`, the skip-armed path, so only where
      skip could start) under the pill "Read already: skipping"
      (render/skip.ts); Space stops it with "Skip off". The wheel walks
      a span after the last-picked route leading in and back; a save,
      reload, bookmark or resume inside a span keeps the route, with no
      new saved field (in a span = the top frame's route's `then` holds
      the cursor). Completion needs the span's end seen; span ends count
      as endings and route boundaries for `u` and the end card;
      `regionEnd` includes spans. folder_model.py's reach walk follows
      spans (`enter_span`, `end_span`, `menu_end`), so span items no
      longer warn "never shown". Subagent's calls: skipTick's
      stop-at-the-last-seen check looks at a route or span end's own
      next step, not the next array item; a running Tab burst carries
      on through a span as a normal burst; biome's
      `suspicious/noThenProperty` is off (the field is named `then`);
      i18n.mjs skips auditing `pill.readAgain` until item 9g. Tests:
      shared.test.ts 19 (17 failed first), reach.test.ts's generator
      with spans (failed against the old Python), a skip pill test,
      validator and folder-model reach tests, scenario file shared
      (read, playall, reload; 4 of 7 checks fail without `then`).
      Orchestrator: npm test 1952 passed, check clean, smoke 6/6;
      shared, branches, follows and media 130/130 on Chrome; shared and
      branches 89/89 on WebKit; the validator, spans, malformed, scale,
      routes and report tests 645 passed.)
- [x] The read-already pill in every interface language (item 9g).
      (2026-11-27: `pill.readAgain` translated in all 38 PO files, each
      with the language's own skip word from its "Skip on" pill and
      `keys.skip` and its read word from `keys.end`, its colon spacing
      (fr's no-break space, ja/zh full-width); he uses the plural so no
      gender is chosen. The audit exemption in i18n.mjs is gone; no key
      is exempted. Orchestrator: `npm run i18n` leaves the generated
      files current, npm test 1952 passed, check clean.)
- [x] Shared spans on the branch map and in the tools (item 9h).
      (2026-11-27: mapmodel.ts draws a span once, a rounded box on a row
      of its own below its decision's routes, right of every route line,
      its result drawn as a route's (join, dashed return, end mark); a
      new `feed` line runs from each route with `then` into it (a nested
      route drops at its end and runs along the span's row); a route
      with `then` has outcome `"shared"` and the tooltip "goes on to a
      shared scene"; span marks: played once a feeding route completed
      or was entered with the span's last item seen, partly once any
      item is seen, never the last-pick gold; a click on the box enters
      the span (new `Machine.enterSpan`, frames as `u` builds them, the
      lead route the last pick, arrival `jump`); `regionEndOf` and
      routes.py's region include spans. `kinetic routes` lists spans
      after their routes (text, `--json` with `shared[]`/`reachedFrom`,
      `--dot` span nodes and `then` edges); fixtures/route-shapes.json
      counts spans and has a "shared spans" case; `kinetic export`
      prints a span once after its routes (and `DEC.SPAN.md` with
      `--out`); `kinetic report` counts span items once in the total,
      in each route with `then`, and in the shortest reading. New
      strings `map.route.shared` and `map.span.title` in all 38
      locales. README screenshots unchanged (no spans in the showcase).
      Lead: the validator's never-shown text for a span item names
      "none of its routes" (to item 9i). Tests: routes 11, export 2,
      report 2, mapmodel and routeshape 14 failing first.
      Orchestrator: npm test 1959 passed, check clean, smoke 6/6;
      branchmap, bookmarkmap, branches and shared 184/184 Chrome;
      branchmap and shared 72/72 WebKit; routes, export, report,
      malformed, jump-menu and build-apps tests 294 passed.)
- [x] The converter lays a shared tail out once (item 9i).
      (2026-11-27: flow.py records each label's first visit and path
      ends, cuts a label two or more routes reach out of the first route
      that read it (a `shared-mark`) and lays it out once before the
      owner's `menu-close` behind a `shared-open` marker
      (`plan_span`, `lay_out_spans`); timeline.py ends spans, gives
      candidates `shared`/`then` and joins at a span; cli.py names spans
      `shared-<label slug>` (unique across the manifest) and sets
      `then`; audio cues move with the span and play on from the cut;
      the span's first line repeats the visual at the cut when another
      came between. Subagent's calls: the owner is the innermost
      decision enclosing every route reaching the label, fixed when the
      outermost open menu closes; a nested menu whose choices meet at
      the label makes the outer route's `then` and the nested
      decision's `continueAt` the span's first item; a run fits when it
      holds no menu, ends at the join, the story's end or back to the
      menu, and every route reaching it ends only there, else every
      menu holding a rejoining route stays linear as before; a route's
      own `result` is the span's (what an older player acts on); with
      no join left, `continue` spans become `ending`; a shared label
      with no lines needs no span; a span whose items were all dropped
      is withdrawn with its `then`s. Gate: every route with `then` is a
      route of the span's own decision, because Play all routes cannot
      yet read a nested route's siblings once it leaves through an
      enclosing span (lead: item 9i2). The validator's never-shown text
      names the shared span. On the reporting game (read-only walk) the
      gate keeps all 29 rejoining menus linear (65 decisions, 0 spans);
      lifted, 77 decisions, 4 spans, 16 `then`s, 17 left, but 309 items
      never shown under Play all. Tests: test_shared_tails.py 10 (7
      failed first), the validator's span warning. Orchestrator: the
      shared-tails, jump-menu, route, conditions, spans, validator,
      branch-extract, flow, audio and episodes tests 740 passed; the
      renpy_demo golden unchanged, 12 passed.)
- [x] Play all routes reads a nested route's siblings after an
      enclosing span, and the converter's gate lifted (item 9i2).
      (2026-11-27: machine.ts's `endSpan`, under Play all routes, at
      the end of a span entered from a route of another decision, walks
      from that route's decision outwards, short of the span's
      decision, and re-offers the first with a route unplayed this pass
      (`spanReturn`; the frames of the routes holding it pushed back;
      "Back in time" names the leading route); only when none qualifies
      does the span's `result` act at its own decision. Subagent's
      calls: a nested pure choice met on that walk with every route
      played closes there when its close lies inside its holding route
      (`closesInside`), so the enclosing route reads on; an enclosing
      route a re-offer carries to its end completes there, the others
      stay left, not completed; the re-offer sits over the span's last
      item (`PendingChoice.over`, read by `anchorOf`, `screenKey`,
      `reopenChoice`; no save-format change), so the wheel steps back
      onto that item and a reload reopens it; `endStep` is -1 there, so
      `u` and skip predict no join. Play all routes off and the wheel's
      story-order walk unchanged. folder_model.py's reach walk mirrors
      it (`span_return`, `holder_route`, `reopen_around`); flow.py's
      gate is gone. On the reporting game (read-only walk): 77
      decisions (65 before), 4 spans, 16 `then`s (13 nested), 17
      rejoining menus left linear (29 before), 0 validator problems, 0
      never-shown items (309 with the old walk). Tests: 10 machine tests
      (9 failed first), reach.test.ts's generator with deep `then`s,
      Python reach-walk tests (4 failed first), converter nested and
      chain cases (3 failed first), scenario parts playall and nested.
      Orchestrator: npm test 1969 passed, check clean, smoke 6/6;
      shared, branches, follows and branchmap 166/166 Chrome; shared
      and branches 91/91 WebKit; converter and validator tests 688
      passed.)
- [x] Conditions only on story state (item 9k).
      (2026-11-27: parser.py records every place a variable is set that
      the converter cannot read (`UNREAD_OPS`, `Assignment.unread()`: a
      label or call parameter, a loop, Python code, screen actions,
      `setattr`, other operators, unpacking, a non-literal value), and
      label parameters and call sites. A chain on its own label's
      parameter whose every `call`/`jump` gives a literal (or the
      literal default) takes, at each call, the arm that value picks:
      no decision (flow.py's pick fork; a later call reads only the arms
      not yet read). Any other unreadable variable (Python, loops,
      screens, random, input, `_return`, another variable, expressions)
      is a decision the reader picks, as before, so its lines stay; the
      reason is in the `branchDetection` note, the ledger's
      `conditions[].readerPicks` and `kinetic report`'s conditions
      section. An arm is dropped as never taken only when every setter
      is read ("all 3 places that set x are read, and none gives a value
      it takes"). `persistent.`, `config.`, `preferences.`,
      `store.x.y`, `_in_replay` stay unconverted. Orchestrator's call:
      the plan's "stays unconverted" lost text on run-time state (about
      3,450 items on one corpus game), so run-time state became a
      reader's pick with its reason instead. test_report.py's
      shared-span expectation corrected (item 9i2 made those items
      reachable). Corpus recount (5 games, read-only), text items
      kept: 54966 -> 55122, 49387 = 49387, 5213 -> 11296, 3936 = 3936,
      12772 -> 12843. Tests: test_condition_state.py (29 failed first).
      Orchestrator: full converter/ 1342 passed.)
- [x] Joins through calls and returns (item 9l).
      (2026-11-27: the walk keeps the call stack: a `return` in a called
      label goes back after its `call`, in a menu's choice too; only a
      `return` with no call under way ends the story. A menu's join is
      found through returns, so it can lie past the `call` (walked with
      the caller's state). A join opening with a `call` of a label that
      shows nothing, an unconverted `if` whose blocks show nothing, or a
      linear `if` chain straight after the menu takes the first item
      after it as `continueAt`. `call expression` candidates: each
      candidate's `return` goes on into the next, the last after the
      site; a choice's own `return` in a candidate other than the last
      meets the others only when the join returns at once, else it is
      `"ending"` (treating candidates alike lost lines). "A menu straight
      after a menu" kept as it was, for item 9o. A menu the walk never
      lays out now says why (`not reached: ...` or `inside a block the
      walk does not read`); "(slice)" is left for `--max-items`. Corpus
      recount (5 games, read-only): one game's ending routes mid-story
      544 -> 64 and its 242 "region not completed" all became "not
      reached" (dead code after a `jump`/`return`); pure choices 1051 ->
      1006, 422 -> 291, 770 -> 362; script lines kept identical in all
      5, text items fell only by choice-text placeholders routes no
      longer need. Lead for item 9m: say strings spanning several lines
      are mis-parsed (a continuation line read as `return`). Tests:
      test_call_joins.py, 15 (12 failed first). Orchestrator: converter/
      1357 passed, test_validate_content.py 536 passed.)
- [x] Say statements as Ren'Py reads them (item 9m).
      (2026-11-27: the parser reads Ren'Py's logical lines (new
      renpy_lexer.py, the lexer moved out of translations.py): a line
      runs on while a string or bracket is open or after a backslash,
      sits at its first physical line, and a line break inside a plain
      string becomes one space; triple-quoted say strings are monologue
      mode, one line per paragraph. `e happy "..."` is e's line, the
      attributes changing the picture only when e's Character gives a
      literal `image=` and that tag is on screen, chosen as Ren'Py's
      `choose_image` does (`-x` removes, `@` lasts one line), else a
      ledger note. `c.name "..."` resolves `define c.name = Character`
      and `init python in c:`; a plain `e` finds `define character.e`.
      `"Name" "text"` is Name's line; `call x()` with `from` on the
      next line is one call; `if(`, `elif(`, `while(` read. Choices:
      `hide` not tracked; a file-named picture changes only for a file
      named exactly `tag attrs`; single-line double spaces kept
      (future.md). Leads: `Character(None)` speakers and monologue
      translations became item 9m2; Python-class speakers to future.md.
      Corpus recount (all 71 games, parse-only, read-only), over the 46
      that changed: text items 363,756 -> 486,690, say lines kept
      427,702 -> 626,826, dropped as unrecognized say 26,147 -> 0, 8,979
      lines read with corrected text, 17,415 with corrected speakers;
      the multi-line game 345 -> 96,461 text items. renpy_demo golden
      unchanged. Tests: test_say_forms.py, 24 (23 failed first).
      Orchestrator: converter/ 1381 passed, test_validate_content.py
      and test_translations.py 578 passed.)
- [x] Nameless speakers and monologue translations (item 9m2).
      (2026-11-27: a line by a nameless Character is narration with a
      ledger note: `Character(None, ...)`, `name=None`, no name with a
      nameless literal `kind=` chain or no `kind=` at all (Ren'Py's
      `adv` has none), and Ren'Py's own `narrator`, `centered`,
      `vcentered`, `nvl_narrator`, `adv`, `nvl` unless the game defines
      them; through `define character.x`, dotted names and `init
      python`. An unreadable name or kind keeps the variable as speaker.
      Narration takes no colour, so a `what_color` is noted as not
      carried. test_presentation.py's `kind=nvl` case now expects
      narration, as Ren'Py shows it. Monologue paragraphs each have
      their own source key (`game/x.rpy:LINE#k`), so each matches its
      own `translate` block, by identifier or by location comment. Leads
      left: an explicit `id` on a monologue string gives every paragraph
      one identifier (rare); a `{clear}` paragraph, which Ren'Py reads as
      `nvl clear`, occurs in no corpus `.rpy` (orchestrator's grep: 0).
      Corpus recount (39 games, parse-only, read-only): speakerless lines
      77,752 -> 81,602 in 17 games (much of it Ren'Py's `centered`,
      shown before as a speaker "centered"), translated lines matched
      468,735 -> 468,765, total lines unchanged in every game. Tests: 20
      in test_say_forms.py (14 failed first). Orchestrator: converter/
      1401 passed, test_validate_content.py and test_translations.py
      578 passed.)
- [x] Pictures resolved as Ren'Py resolves them (item 9n).
      (2026-11-27: `image a = "b c"` reads its string as Ren'Py reads a
      displayable (a dot a file, `#` a solid, else an image name, 8
      deep); `image` in `init:`/`init N:` read; `.avif` ships through
      the pinned Pillow, as BMP/TIFF do (`IMAGE_EXTS`), with a new
      self-test case `pillow.decode-avif`; file names match whatever
      their case after every exact match, the ledger naming the file as
      on disk; `ConditionSwitch`/`ShowingSwitch` and other displayables
      show their first picture that resolves, noted; `show x:` with ATL
      names `x` and its block is no longer read as lines; a non-frame-
      list ATL image shows its first resolving string or leaves the
      visual (a `Solid` flash); images-folder names join item 9m's
      attribute choice; a visual that resolves nowhere keeps its lines
      over the last visual, noted and reported (`unresolvedVisual`).
      Choices: a file beside a same-named solid-colour `image` shows (no
      solid ships; one game lost 127 items otherwise); a route starts
      from the menu's visual state; `behind`/`onlayer`/`zorder`/`as` end
      a show's name. Orchestrator recorded the golden with `kinetic
      setup --repin pillow.decode-avif`:
      6db788c83c946d0ea09d2eb4d93cc3736b48a57728946535b0b64e1f32d8cfcc
      (sample.avif sha256
      21c8289b5675e4b253fd8747731a470102fb68ace1510948509e7d3665fed64e);
      shared, not cpu-dependent: Pillow 13.0.0 (libavif 1.4.2) decodes
      it to the same pixels on arm64 and on x86_64 under Rosetta
      (22376a59...0134). Leads: a line before any picture makes an
      invalid first `text` item (orchestrator reproduced it), single-
      quoted ATL frames, `pause (N)`, `show` attribute choice,
      `renpy.image()`, `Movie()` images -> item 9n2; `[var]` image
      names -> item 9q; the picture state after a menu -> item 9r;
      `layeredimage` -> future.md. Corpus recount (71 games, parse-
      only, read-only): lines dropped with an unresolved visual 34,512
      in 44 games -> 3 in 2; lines kept 885,392 -> 918,916; 7,951 kept
      over the last visual; unresolved visual statements 22,360 ->
      2,828; no game lost a line. Tests: test_picture_forms.py, 25 (22
      of the first 24 failed first). Orchestrator: converter/ 1426
      passed, test_validate_content.py and test_setup_media_tools.py
      569 passed, setup self-test 23 cases passed.)
- [x] Pictures the converter still misses (item 9n2).
      (2026-11-27: a line before any picture (the story's start, after
      a starting `scene black`, under a visual that resolves nowhere)
      shows over one generated black PNG at the game's size; ledger
      source `{"generated": "black"}` with a `solid` step, which
      `kinetic media rebuild` makes again and checks; item 9n's
      `droppedUnresolved` drop is gone. Single-quoted ATL frames,
      `pause (N)`, `pause(N)` and a bare `(N)` animate. `show tag attrs`
      whose name resolves nowhere takes Ren'Py's attribute choice
      (`scene` keeps none). Literal `renpy.image()` calls define images.
      `Movie(play=...)` ships as a video; a `Movie` with no `play` shows
      what its channel plays (`play movie`, any `movie=True` channel);
      arguments a video cannot hold are noted "not carried". Choices:
      the name as written resolves first, so no resolving show changed;
      the black still ships after the asset pass, once the size is
      known; three tests asserting the old drop rewritten. Leads: solid-
      colour scenes later in a story, a menu before any picture, and
      say attributes trying the exact name first -> item 9n3; `loop=False`
      videos -> item 9n4 (holdLastFrame is animation-only today);
      `renpy.movie_cutscene` already in future.md. Corpus recount (71
      games, parse-only, read-only): invalid first `text` item 21 games
      -> 0; 547 lines over black in 23 games; drops 3 -> 0; lines over
      the last visual 7,951 -> 7,202; unresolved visual statements 2,828
      -> 2,131; animation items 1,997 -> 2,132; video items 8,446 ->
      9,363; total lines 917,365 -> 917,366. No attribute shows or
      literal `renpy.image` calls occur in the corpus. Orchestrator's
      grep: 14,528 solid-colour `scene` lines, 1,205 `loop=False` Movies
      in 6 games. Tests: 16 new in test_picture_forms.py (15 failed
      first). Orchestrator: converter/ 1441 passed,
      test_validate_content.py 536 passed.)
- [x] Solid-colour scenes and a menu before any picture (item 9n3).
      (2026-11-27: Ren'Py's built-in `black`, an undefined `white`,
      `image x = "#rgb"` (3, 4, 6 or 8 digits) and `Solid(...)` with a
      literal colour show a generated still at the game's size, one file
      per colour (`{"generated": "black"}`, the same bytes as item 9n2's,
      or `{"generated": "#rrggbb"}`), rebuilt by `kinetic media
      rebuild`; a sized or variable `Solid` stays reported. `scene #000`
      is a bare `scene` in Ren'Py (`#` starts a comment), so black. A
      menu or `if` decision before any picture follows a bare black
      still. Say attributes try the exact image name first. Choices: a
      translucent `show` keeps the picture, noted; a translucent `scene`
      blends onto black; only `game/black.*` or `images/` files replace
      the built-in black/white; a solid colour replaced before any line,
      pause, menu or `with` makes no item (Ren'Py never shows it), while
      a transition or `pause` makes a bare item, as for any picture
      (3,808 bare stills in the corpus). Leads: a bare `scene` resolving
      a game's own `image black`, solid-colour ATL frames and `show
      black:` with ATL alpha -> item 9n5; `show screen` -> future.md;
      menu captions -> item 9o. Corpus recount (71 games, parse-only,
      read-only): lines over a solid still 547 -> 23,465 (9 over white),
      generated still items 25 -> 8,000 in 57 games, "solid color
      screen" reports 11,332 -> 0, menus linear for "no item precedes" 3
      -> 0, decisions 16,984 -> 17,006, lines over the last visual 7,202
      -> 7,229 (translucent shows), total lines 917,366 -> 917,362 (4
      condition-arm placeholders no longer needed). renpy_demo golden
      unchanged. Tests: 26 new in test_picture_forms.py (25 failed
      first), test_branch_extract.py's "no items before" case now hangs
      off black. Orchestrator: converter/ 1467 passed,
      test_validate_content.py 536 passed.)
- [x] Videos that play once (item 9n4).
      (2026-11-27: a video item takes `holdLastFrame` with a required
      `lastFrame` still (format rule 31; `lastFrame` only with it;
      refused with `segments`; the range's last frame; file suffix
      `.last`). The player plays its `loopCount` passes under its lines
      and then holds the paused element; a line reached with no run
      under way, rewind, skip, an `e` landing, bookmark and map
      thumbnails (`videoStillFrame`) show `lastFrame`; an older player
      loops. The converter writes it for `Movie(..., loop=False)`: a
      `lastFrame` ledger step and media kind (ffmpeg from a second
      before the end with `-update 1`, falling back to the whole file,
      then the poster's image rule), rebuilt by `kinetic media rebuild`;
      `kinetic media ship` takes `"lastFrame": true` on a video request.
      Choices: the converter ships the still rather than the player
      seeking; the live hold may sit one frame past `lastFrame` after a
      range ending inside the file (documented). New self-test case
      `ffmpeg.last-frame`; orchestrator recorded its golden with
      `kinetic setup --repin ffmpeg.last-frame`:
      8d3ccb4e2109d9758d8872fcc846de7effd39c48a688b4f9cd0e35bc4f55fcbf.
      Open for the user before the closer: `ffmpeg.poster-frame` has
      its own linux-x86_64 and windows-x86_64 goldens, so this case
      likely needs `cpuDependent` too, which only the user extends.
      Leads: a held video repeated at a route's start replays, and
      `kinetic media posters` does not check `lastFrame` -> item 9n6.
      Tests: 9 validator, 10 player unit, the Movie converter cases, 4
      last-frame tests, media part `heldVideo` (failed first as noted
      in the report). Orchestrator: npm test 1981 passed, npm run check
      clean, smoke 6/6, media 36/36 Chrome and 36/36 WebKit, segments +
      fileend + videosound 95/95 Chrome and 105/105 WebKit, converter/
      1473 passed, test_validate_content.py + test_setup_media_tools.py
      578 passed, setup self-test 24 cases passed.)
- [x] The walk's time on very large games (item 9n4b).
      (Cause: no slowdown but a hang in `finalize_branches`, there
      since the first release: a decision id cut to 64 characters lost
      its `-n` suffix in the cut, so the search for a free id never
      ended once two decisions shared a cut id (a long label name
      leaves no room for the line number). Item 6's `if-` decisions
      first hit it in the corpus; the commit before item 6 finishes,
      every one after hangs. The note that item 9n3's recount finished
      these episodes was wrong: they had timed out. Fix: `suffixed_id`
      cuts the base, never the suffix; the set of ids in use is built
      once and grows, and each base's suffix search resumes where it
      stopped; span ids avoid a persistent set instead of a union per
      decision, same results. Ids that never reached the cut are
      unchanged; the renpy_demo golden is unchanged. Guard:
      `test_decisions_sharing_a_cut_id_each_take_a_suffix_at_once`,
      300 menus in a 60-character label, unique ids within 64
      characters and exactly 299 `suffixed_id` tries (fails on the old
      code; the fix without the resumed search makes 44,850). Timings,
      three episodes of the corpus's largest game: over the 30-minute
      cap at HEAD, aa054f0 and a9eff20; 90 to 113 s with the fix; walk
      output identical to the old algorithm with only the cut fixed,
      and the five colliding decisions per episode now take `-2` to
      `-5`. Lead, not an item: the remaining walk time is linear
      parsing (`strip_comment`, `ast.parse`, the file walk,
      `follow_labels`). Orchestrator: converter/ 1474 passed,
      test_validate_content.py 545 passed, the guard fails against
      HEAD's cli.py, one episode walked in 124 s at load 7.)
- [x] Solid colours in the last places (item 9n5).
      (A bare `scene` (`scene`, `scene with fade`, `scene #000`) shows
      the generated black still whatever the game's own `image black`
      is, noted when that differs, `scene black` still the game's;
      solid-colour frames of an ATL frame list are generated stills at
      the game's size, one per colour, each frame `decision:
      "generated"` with its own `solid` media entry, rebuilt by
      `kinetic media rebuild`; a solid colour's `scene x:`/`show x:`
      block takes its last `alpha` (bare or a warper's end value) into
      item 9n3's translucent rule. Choices: a translucent frame is laid
      over black, and over a picture the whole animation keeps its
      lines over that picture; an `alpha` the converter cannot follow
      (not a number, nested blocks, `repeat`, `choice` and the like)
      leaves the colour as it was, reported. Tests: 21 cases, 19 failed
      first (the other two guard existing behaviour). Recount, all 79
      entries on both sides, before an ebf1f96 copy: 75 walked on each
      side, the same 4 fail on both (3 entries with no game folder, 1
      with no items), longest walk 281 s; total lines unchanged at
      1,317,879; lines kept over the last visual 74,841 -> 74,830; 7
      bare scenes now black; 7 frame lists with solid frames, 6 now
      animations; 12 frames unresolved for being a colour -> 0; 11
      solids with ATL `alpha` (2 stills, 9 kept over the picture, the
      7 in one game white flashes fading to 0 that showed opaque
      before). Leads, sensible answer taken: ATL `alpha` on images,
      pictures and named transforms, and one translucent frame losing
      a whole animation, affect a few dozen lines in two games, so they
      go to docs/future.md's cosmetic gaps, not items. Orchestrator:
      converter/ 1495 passed, test_validate_content.py 545 passed,
      recount status logs checked.)
- [x] Held videos repeated and checked (item 9n6).
      (Where the converter repeats a held video's picture (a route's
      start), the item is an image whose `file` is the video's
      `lastFrame`, one ledger entry, its item entry `decision:
      "lastFrame"`, dropped with its video. `kinetic media posters`
      checks each held video's `lastFrame` by ledger (the `lastFrame`
      step's end and source) or by pixels (decoded as item 9n4's step
      takes it, the poster tolerance), with `FAIL <id> lastFrame:`
      lines and a `last frames:` summary printed only when the manifest
      has held videos. Choices: `--fix` writes last frames to a new
      `--last-frame-remap FILE` so `--remap` keeps its id -> poster
      shape; without that flag a wrong last frame is `NOT FIXABLE`
      (exit 1) and posters are still fixed; `kinetic media ship` takes
      `endSeconds` with `"lastFrame": true`; `--first-frame` skips
      posters only. Lead fixed in the item at the orchestrator's
      request: an end within 1e-6 s of `durationSeconds` reads as the
      file's end in the by-ledger check, both ways. Lead noted: the
      still keeps the video's `asset` in its ledger item entry, marked
      by its `decision`. No new self-test case: the still uses item
      9n4's recipe. Tests: the route opening after a held video
      (validated `--strict`, `kinetic routes`, `kinetic check`), the
      checker finding wrong stills by ledger and by pixels, the fix
      into its own remap, the remap flag's absence and misuse, the end
      at the duration, ship's `endSeconds`; all failed first.
      Orchestrator: converter/ 1505 passed, test_validate_content.py
      545 passed; AGENTS.md's posters line names the new flag.)
- [x] Menus no longer kept linear (item 9o).
      (A conditional choice is a route labelled with its condition in
      words, or "(not always offered)" when the test cannot be worded
      (reported); a stat choice (every choice empty, all reaching the
      join) is a decision of its choice lines, all `"continue"`; a menu
      right after another decision gets a line before it, its caption
      or "Another choice follows."; menu lines are read as Ren'Py's
      `parse_menu` reads them (any quote style, choice arguments, a say
      menuitem prompt, `set`, `with`, `$`, `pass` and later captions
      passed over, a `label` in a choice block flowed through); a menu
      still kept linear keeps its choices' lines in a row, reported. 3
      new phrases in all 38 PO files, `npm run i18n` rerun. Choices: the
      `menu "x":` lead is not real (Ren'Py's menu statement takes only
      a name and arguments before the colon), the single-quote lead was
      real and is fixed; a variable the menu's own choices set (a hub)
      is worded by its test alone; a say menuitem is the prompt; the
      file-order walk keeps stat choices linear (no provable join).
      Tests: test_menu_shapes.py 14, the first 13 failing against
      a22a4b0, each decision shape validated `--strict`, routed and
      walked with `kinetic check`; 7 existing test files updated. Corpus
      recount, 75 of 79 entries on both sides (4 with no folder or no
      items), slowest walk 341 s: total lines 1,317,879 -> 1,407,642;
      decisions 28,115 -> 33,715; conditional-choice routes 0 -> 2,871;
      stat-choice decisions 0 -> 883; linear menus 5,162 -> 2,777;
      lines in linear menus kept/lost 15,524/89,682 -> 35,823/6,972.
      Leads -> items 9o2 (shared spans holding a decision's `after`,
      validator failures in corpus output), 9o3 (say-menuitem and
      default prompts untranslated), 9o4 (rejoin-linear menus, 6,607
      lines lost); `and`/`or` and attribute tests in choices -> item
      9p's wording. Orchestrator: converter/ 1519 passed,
      test_validate_content.py 545 passed, npm test 1981 passed, npm
      run check clean; de, fr, ja, ar and ru phrases read in the words
      file.)
- [x] Shared spans that hold a decision's `after` item (item 9o2).
      (Cause: a decision whose join has no item of its own is a pure
      choice and lays out its shared span after its routes, so an `if`
      chain or menu opening next with no item between took the span's
      end as its `after`; the join was lost by a released itemless `if`,
      a path ending into the next computed-call candidate, or a `link`
      to a menu not open. The rule is right (a span holds no decision),
      so the converter changed: the later decision gets a line of its
      own before it, its caption or "Another choice follows.", which is
      the earlier decision's `continueAt` when it still waits on its
      join; none when it stays linear or opens a route (item 8c's
      choice text). Choices: a line rather than a silent repeated
      picture; the existing phrase reused for chains, so no new words.
      Tests: 6 in test_shared_tails.py, the 5 shape cases failing at
      8617912 (their folders refused by the validator), 2 guards (one
      caught the first version replacing choice text in one corpus
      game). Recount, 75 of 79 entries on both sides: "shared span
      holds a decision" 19 in 7 games -> 0, no other branch-rule
      problem on either side; lines 1,407,642 -> 1,407,661 (+19 lead
      lines, none lost in any game); decisions 33,715 and continueAt
      24,032 unchanged. Leads -> items 9o2b (about 813,000 items
      never shown in the corpus outputs), 9o2c (the same lost join with
      no span between), and 9o3 (the line before a following chain).
      Orchestrator: converter/ 1526 passed, test_validate_content.py
      545 passed.)
- [x] Items the player never shows (item 9o2b).
      (Real, not the survey: one cause covers all 813,368 never-shown
      items, in 31 of 75 walked games. A decision with no item between
      its close and the next menu or chain became a pure choice, the
      next decision hung off its last route's last item, so the player
      offered it from that route only and a reading of any other route
      stopped there, never showing the rest of the story. The decision
      went pure when its join path ran through a `return` or an `if`
      that shows nothing (item 9o2c's shape), or ended and the walk went
      on elsewhere. A real extract of one affected game at 797601e gave
      4,745 never-shown items, 0 after. Fix: a crossed `path-end` keeps
      the waiting decisions waiting as released; the next decision gets
      item 9o2's line before it whenever the last item ends a span or
      any decision's region, and a released decision continues there
      (`lead_kind` join/span/return/region, its notes). Choices: after
      a pure choice whose join really ended, the earlier decision stays
      pure and only gets the line, no join invented; this replaces item
      9l's "pure choice, menu hangs off its last route" rule. Tests:
      test_never_shown.py 6 cases, all failing at 797601e, each
      validated `--strict`, routed and walked with `kinetic check`; one
      shared-tails test updated (its decision now continues at the line
      before the next candidate's chain). Recount, 75 of 79 entries on
      both sides, slowest 327 s: never shown 813,368 -> 4; lines
      1,407,661 -> 1,409,336 (+1,675 lead lines, no other line changed
      in any game); decisions 33,715 unchanged, with `continueAt`
      24,032 -> 24,505; branch-rule problems 0 -> 0. Leads -> items
      9o2d (the 4 left), 9o2e (route ids from `_` labels and empty
      Character names refused by the schema, and a schema pass in the
      recount), 9o2f (nested choices in called labels ending where
      Ren'Py goes on). Orchestrator: converter/ 1532 passed,
      test_validate_content.py 545 passed.)
- [x] A decision giving up its join at a later one (item 9o2c).
      (Done in item 9o2b: its "join past an `if` that shows nothing"
      and "past a `return`" cases are this shape, each with a test in
      test_never_shown.py, and docs/extracting.md's pure-choice rule
      changed with it.)
- [x] No repeated arm line after a nested decision (item 9o2d).
      (Cause: `close_menu` judged a nested menu on the choice endings
      known when it closed; a called label's menu whose choices meet
      only through its `return` looked linear then and became a
      decision only at `resolve_region`, so the enclosing `if` arm kept
      no story and `finish_choice` said its line again after the
      decision. Fix: each menu records its nested menus per choice, and
      a new `judge_region` at `resolve_region` judges the region's
      menus inner first from their own events plus the nested menus
      finally decisions; `finish_menu` turns a choice marker into a
      line only when that choice's final story is empty. Choices: the
      cause fixed, not only the warning, which also removes 9 repeats
      a reader saw at a route's end; the reverse case (a decision at
      close that ends linear) gets its arm line, none in the corpus.
      Tests: 2 in test_never_shown.py, both failing at 0cc2bae, one for
      the `if` with no `else` that is now a decision whose menu's
      routes go on. Recount, 75 of 79 entries on both sides: never
      shown 4 -> 0; lines 1,409,336 -> 1,409,323, the 13 lost all a
      condition arm's line repeating its route's first line at that
      route's end (checked by script), 70 games identical item for
      item; decisions 33,715, `continueAt` 24,505 and branch-rule
      problems 0 unchanged. Leads: the all-`pass` called menu under an
      `if` with an `else` -> item 9o2f; route ids from `_return` ->
      item 9o2e. Orchestrator: converter/ 1534 passed,
      test_validate_content.py 545 passed.)
- [x] Converted folders the schema refuses (item 9o2e).
      (The recount's rules.py now runs the schema and every
      manifest-only rule on each walk output twice, raw and with
      placeholders for the asset pass's fields; only problems in the
      filled manifest count. At 3bb47e7, 1,084 problems in 13 of 75
      games: route ids from `_` labels (924) and the `continuingRoute`s
      naming them (136); item ids over 64 characters past the 10,000th
      item (21) and route starts naming them (2), a new form; a
      `Character("")` speaker (1). Fix: `slug(..., lead=True)` drops a
      leading `_` or `-` for route and item ids; `_next_id` cuts the
      slug, never the place, to fit 64 characters; route ids use
      `suffixed_id`, so the 1,000th route on a long caption keeps its
      number (asked for by the orchestrator, a lead of the item); a
      Character with an empty name, and a `"" "..."` say statement, are
      narration. Choices: prefixed decision and span ids keep their `_`
      (they fit); whitespace-only names are left alone (the schema takes
      them); an empty name is narration though Ren'Py's stock screen
      would show an empty name box. CREATE.md's "Validating" explains
      the contrast warnings the games' own name colours give (832 in
      the corpus), so `--strict` exits 3 on a sound conversion, and what
      an agent can do; the converter is unchanged for them. Tests:
      test_schema_forms.py 21, failing first except the 2 guards and
      the route-number case, which failed with 999 distinct ids of
      1,001; the 9n4b guard counts `menu-` bases only, as route ids now
      call `suffixed_id`. A real extract of the empty-Character game
      validates with exit 0. Recount, 75 of 79 entries on both sides:
      schema and rule problems 1,084 in 13 games -> 0; 945 of 1,571,902
      ids changed, all of them refused before, none that fitted
      (idcheck.py, and routecut.py over 71,433 route ids for the suffix
      rule); lines 1,409,323, decisions 33,715 and never shown 0
      unchanged; 1,068 empty speakers in 13 games now narration.
      Orchestrator: converter/ 1555 passed, test_validate_content.py
      545 passed; CREATE.md's cross-reference to "Generating
      manifest.js" corrected to "below".)
- [x] Nested choices in called labels go on (item 9o2f).
      (Cause: `_menu_join` stopped a called menu's join at the label's
      `return` even with nothing shown before it, so when the caller's
      next statement was the end of an enclosing route (an `if` arm or
      a menu choice holding the `call`) the join's path reached the
      enclosing decision's join with no item of its own: a pure choice,
      routes `"ending"`. Fix in flow.py: a join that only returns is
      lifted to where the `return` goes on, through as many calls as
      return at once, when the walk takes that continuation next and no
      other block of an `if` the walk does not convert is pending in
      the caller's frame; otherwise the join stays as before. The ops
      passed are marked read and their events (a sound, a transition)
      laid out after the `menu-close`, in their old order; a lifted
      block-end join is named by the statement it goes on to
      (`join_text`). Choices: lift only under those two conditions
      (without them the corpus lost rejoins and gained 152 never-shown
      items); item 9o2b's crossed line and `join_text` apply to lifted
      joins only (applied to all item 9l joins they turned 606 routes
      `continue` -> `ending` and lost a decision). Tests:
      test_called_menus.py 14, each checked with validate `--strict`,
      routes and `check --steps all`; 7 failed at fcb6583 (rechecked by
      the orchestrator with HEAD's flow.py: 7 failed, 7 passed), 7
      guards, two proved by removing their check. Recount, 75 of 79
      entries on both sides: lines 1,409,323, decisions 33,715, never
      shown 0 and rule problems 0 unchanged, item sequences identical
      in every game; `continueAt` 24,505 -> 24,858; routes `continue`
      50,062 -> 50,746, `ending` 20,099 -> 19,415, all in 11 games, none
      the other way. Pure-choice `"ending"` routes left in called
      labels: 14,545 -> 13,812; of 4,513 instrumented, about 70% sit
      under a computed call (`call expression`, screen action
      candidates), whose next step Ren'Py computes when the game runs,
      and the rest meet a menu or chain kept linear, jump back to
      content already laid out, or end at an unconverted `if`'s join;
      none is this item's shape and the computed ones stay as they
      are. Leads: a chain met past a crossed `return` and one straight
      after a join treated alike -> item 9o2g; a level-0 block-end join
      read as no join (its ledger note naming an empty place), and a
      called menu in an unconverted `if` with no `else` -> item 9o2h; a
      sound after a nested menu's close cueing only the last route ->
      item 9o2i. Orchestrator: converter/ 1569 passed,
      test_validate_content.py 545 passed.)
- [ ] A chain after a join holds its decision (item 9o2g).
- [ ] Joins at a block's end (item 9o2h).
- [ ] A cue after a nested menu plays on every route (item 9o2i).
- [ ] Menu prompts in the game's languages (item 9o3).
- [ ] Menus kept linear by a rejoin (item 9o4).
- [ ] More `if` chains become decisions (item 9p).
- [ ] Variables shown in text (item 9q).
- [ ] The picture at a join follows the reader's path (item 9r).
- [ ] Fixtures and docs for shared spans (item 9j).
- [ ] Phase-closer (Phase 60): full suites; VERSION 1.15.0, the
      CHANGELOG dated, tag v1.15.0, `main` fast-forwarded, the wheel
      attached to the GitHub release, the Pages demo republished.
