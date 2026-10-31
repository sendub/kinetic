# Verify the Player Shell

 Manual browser checklist for the player, per docs/plan.md Phases 5-9c.
Covers the Phase 5 feature set — `file://` demo folder loading, image
visuals, text + speaker overlay, `h` toggle, space advance,
first-keypress fullscreen, the empty-manifest state — the Phase 6 media
set: animation frame cycling with loop count, video poster-to-play
autoplay, the `text`-chain keeping one `<video>` element alive, and the
rewind still; the Phase 7 input set: wheel rewind and return with both
clamps, `tab` skip, `space` during skip, and `e`; the Phase 7b
presentation rules: media fills the viewport as the largest centred
contain fit of its own aspect ratio, whatever screen it gets, and overlay
text says which mode it is — `data-mode="thought"` for an unspoken
thought, `"speech"` for dialogue — so CSS can draw the two differently
(thought italic, dialogue upright); the Phase 8 bookmark set: `b`
appends timestamped records with a confirmation flash, `t` opens the
thumbnail list oldest-first and scrolled to the newest, clicking an entry
continues the novel from that time point, and the frontier survives a
reload and an `e`-verified bookmark jump; the Phase 9 config set:
`c` opens the config screen showing the current reading speed and
skip-all state, its controls change the settings live — a measured
auto-advance proves the re-armed hold — and the changed values survive
a reload; and the Phase 9b/9c short-video set: two items sharing ONE
2 s clip at different playback ranges — `part-012` plays [0, 1] once and
`part-013` plays [1, 2] twice — which walks the whole range machinery in
a real browser: seek to `startSeconds` on entry, the poster of each range
item being the frame at ITS start, pass completes detected per presented
frame with `requestVideoFrameCallback` (the file's own `ended` bounds a
pass only when the range runs to the file's end, where rVFC can never
see a frame at `endSeconds`), a loop-back seek to `startSeconds` while
passes remain and a pause when none do, and `loop` NEVER on for a ranged
video (the element's own loop would seek to 0). No frame-exact claims
anywhere: steps 27-28 MEASURE what the browser actually presented and
record the observed boundary tolerances (under "measured boundary
guarantee" below). The key
map today holds space, `h`, `tab`, `e`, `b`, `t`, `c` and Escape; the
wheel has its own module (`render/wheel.ts`), because a wheel event is
not a key. While the `t` or `c` overlay is open the
cursor-moving commands (space, `tab`, `e`, wheel) are suspended — the
overlay takes precedence; `b` and `h` keep working.

## Run it

From `player/`:

```sh
npm run build
node scripts/verify.mjs
```

The driver (`player/scripts/verify.mjs`, node + puppeteer-core) launches
headless Chrome, assembles `.tmp/verify-demo` from `fixtures/demo` plus
`dist/index.html` and `dist/app.js` (the fixture's `manifest.js` is never
overwritten), `.tmp/verify-demo-empty` from the `dist` stub manifest, and
`.tmp/verify-demo-tall` — a copy whose item-1 image has been rescaled to
640x960 by `sips` while its manifest still says 960x540, the one shape
that tells the asset's aspect ratio apart from the manifest's — then
drives every step below and prints `PASS`, `PARTIAL`, or `FAIL` per step.
The Chrome profile is wiped before launch: Phase 8 put the frontier and
the bookmark list into IndexedDB, and a run must start from the
first-ever-load state a fresh machine has. Every input is real CDP Input:
`Input.dispatchKeyEvent` for keys, `Input.dispatchMouseEvent` `mouseWheel`
for the wheel and `mousePressed`/`mouseReleased` for the clicks on the
`t` list and the `c` controls. All arrive trusted, so the fullscreen
gesture logic accepts them
as user input and the wheel takes the same path a trackpad takes:
listener → accumulator → machine → renderer. Nothing reads machine state
from the driver — each step asserts what the DOM shows; the bookmark
records are read back from the player's own IndexedDB, the `t` list
is read as the reader sees it (order, scroll position, decoded
thumbnails), and the `c` panel is read as its readout and switch state.
Steps 21 and 30 are the exceptions on inputs: they set the
viewport themselves, the way rotating a phone does, and step 30's pages
open in fresh browser contexts — their own storage, so each is a
first-ever load on item 1's image, untouched by the frontier the main
walk persisted (steps 27-28 push that frontier onto part-013, a video).
Exit code is 0 when
every step is PASS or PARTIAL, 1 on any FAIL.

To walk it by hand instead: run `node scripts/verify.mjs` once (or
assemble the folder yourself per CREATE.md § Playing the folder), open
`.tmp/verify-demo/index.html` in Chrome with DevTools' console open, and
press keys. One machine fact keeps the manual walk predictable: the
first space press on a freshly shown item completes it in place
(immediate-complete, machine Phase 3) and the next press moves on, so
advance two presses per item. For the wheel, one mouse notch is 100 px of
delta and steps exactly one item; steps are capped at ~12 per second, so
a fast flick cannot outrun the eye. For step 29, drag the window to a
shape that matches nothing — tall and narrow, or wide and short — and the
media should stay flush with one pair of edges, centred on the other
axis, with black only where the asset's aspect and the window's differ.
For step 19, the demo's two thought lines — line-008 over the looping
video, line-011 over the pier still — should read italic, and every other
line upright. For steps 20-23 press `b` at two different items (wheel
back once in between), `t` to see the list at the bottom, click the
older entry, `e` to return; note the first Escape belongs to the browser
while fullscreen (it leaves fullscreen), so the overlay's second Escape
is what closes it. For steps 25-26 press `c` for the config screen,
click the stepper's `+` and the skip-all switch to change settings live,
close with backdrop, `c` or the second Escape, and reload to see the
changed values read back at startup (set them back afterwards, or the
next manual walk starts at the reader's own pace — which is the point).
For steps 27-28 advance to the demo's last two items, which share one
2 s clip at different ranges: part-012 should show the clip's first half
once and move on; part-013 (`loopStartSeconds: 1.5`) should show [1, 2],
snap back to 1.5 s — not to 1 s — show the rest once more, then hold
near the end: a 1.0 s pass then a 0.5 s pass, no third pass, and `loop`
never checked anywhere on the element.

Results below were walked on 2026-10-31 by the driver on headless Chrome
156.0.8078.76, multiple times with the same statuses (31 steps: 30 pass,
1 honest partial; the evidence lines differ only in bookmark timestamps,
sampled video `currentTime`, the step-27/28 boundary measurements and
range-frame counts, skip-dwell timings and the step-26 hold
measurement). The fit rule in step
30 is pinned twice over: the pure `containFit` in `render/fit.ts` is
unit-tested, and the driver imports that same function as its expectation,
so the two cannot drift. The `t` list's pure rules (order,
scroll-to-bottom, timestamp, thumbnail fallback) are unit-tested in
`render/bookmarks.test.ts`, and the overlay's precedence rule
(`suspendTimeline`) in `render/keys.test.ts`. The `c` screen's pure rules
(speed stepper steps and clamps, the readout text) are unit-tested in
`render/config.test.ts`, the live-change semantics of `readingSpeed` and
`skipAll` in `machine.test.ts`, and the settings' storage round-trip in
the `storage.test.ts` contract suite. The range-plan rules (entry start,
loop restart point and end in the plan, `loop` off for any range,
pass-boundary source rVFC / `timeupdate` / `ended`) are unit-tested in
`render/visual.test.ts`.

## Measured boundary guarantee

The player makes NO frame-exact claim about range boundaries; it
measures what the browser actually presents and states the guarantee it
keeps: playback stays inside the range, and boundaries land within the
tolerances below. Walked 2026-10-31, headless Chrome 156.0.8078.76:

- `requestVideoFrameCallback` availability: **available** (Chrome/Edge/
  Safari have it; Firefox pre-133 does not — the renderer checks at
  runtime and falls back to `timeupdate`, which fires only every
  ~4-250 ms and so lands boundaries up to that coarse interval late;
  the fallback notes itself once on the console when used).
- OBSERVED max start offset (first presented frame after entering a
  range, both ranges): **+0.000 s** — the entry seeks landed exactly on
  `startSeconds` this run; treat this as measured on this browser/file
  pair, not a universal bound. Keyframe-gated seeks could land on an
  earlier frame elsewhere; the format doc's guarantee is in-range
  playback, never frame-exact starts.
- OBSERVED max end overshoot (pass-complete past `endSeconds`, rVFC
  path): **+0.000 s** at 25 fps, with frame cadence 0.04 s bounding it by
  construction — a pass completes on the first PRESENTED frame at or
  after the bound, so the overshoot is bounded by the presentation
  cadence, not by a promise. The `timeupdate` fallback would replace
  that bound with its ~4-250 ms cadence.
- OBSERVED loop-back landing past `loopStartSeconds` (part-013's seek
  back to 1.5 after pass 1): **+0.020 s** (`mediaTime=1.520`) — a pass
  resumes on the first PRESENTED frame at or after the restart point,
  and 1.5 s is not itself a 25 fps frame time (frames sit at 1.48 and
  1.52), so this is the cadence bound working as designed. The landing
  was at 1.5, not 1.0: the pre-roll played once, as Phase 9d requires.
- The driver asserts generous bounds (≤ 0.15 s start offsets and
  loop-back landing offsets, ≤ 0.25 s rVFC overshoot, range containment
  [-0.05, end+0.05]) so a slower machine still passes while the
  OBSERVED numbers above record what this one showed.

## Checklist

### 1. Demo folder loads

- Action: open `.tmp/verify-demo/index.html` in Chrome.
- Expected: the item-1 image (meadow-001.jpg) shows inside `#stage`;
  `#overlay` is visible with `#overlay-speaker` "Mei" and its line in
  `#overlay-text`; the hidden `#bookmarks` and `#config` panels are
  mounted but not up; console is empty.
- RESULT (PASS, 2026-10-31): driver step 1: `#app` children are
  `[stage, overlay, bookmarks, config]` with both panels closed, image
  decoded and painted, speaker and text as expected.

### 2. First keypress requests fullscreen

- Action: press space once.
- Expected: the player requests fullscreen on that first trusted key
  press (CREATE.md § Playing the folder) and nothing errors.
- RESULT (PARTIAL, 2026-10-31): driver step 2: `requestFullscreen` was
  called exactly once, triggered by the first keydown with
  `isTrusted=true`, and `document.fullscreenElement` settled to
  `<html>`; zero uncaught errors. The actual fullscreen visual effect is
  not observable headless, so the last inch stays human: on a real
  Chrome the window should visibly enter fullscreen.

### 3. Space advances through the first images

- Action: press space twice (settle, then move).
- Expected: item 2 (lantern-002.jpg) shows with its line; no speaker
  element, since that item has none.
- RESULT (PASS, 2026-10-31): driver step 3: lantern image decoded,
  overlay shows only the text (1 child, no `#overlay-speaker`).

### 4. Bare image shows no overlay

- Action: advance to item 3 (sunset-003, image without text).
- Expected: the image shows; `#overlay` is `[hidden]` and holds zero
  child nodes.
- RESULT (PASS, 2026-10-31): driver step 4: sunset-003.jpg decoded,
  `overlayHidden=true`, overlay children 0.

### 5. Advancing restores the overlay

- Action: advance to item 4 (window-004.jpg).
- Expected: speaker "Theo" and its line appear over the image again.
- RESULT (PASS, 2026-10-31): driver step 5: image decoded, speaker and
  text as expected.

### 6. `h` hides the overlay, visual stays

- Action: press `h`.
- Expected: `#overlay` becomes `[hidden]`; the image stays visible and
  unchanged.
- RESULT (PASS, 2026-10-31): driver step 6: `overlayHidden=true` while
  window-004.jpg stays decoded and painted (width > 0).

### 7. `h` again restores the text

- Action: press `h` again.
- Expected: the overlay shows the same speaker and line again.
- RESULT (PASS, 2026-10-31): driver step 7: `overlayHidden=false`,
  speaker and text unchanged.

### 8. Animation plays: frames advance at 8 fps, stop after 2 loops

- Action: advance to item 5 (spark-005, 4 frames at 8 fps, `loopCount`
  2 — 1000 ms of cycling).
- Expected: `#visual-image` shows `spark-005.f000.jpg`, its `src` then
  changes at the frame cadence; after the two loops it holds the final
  frame `spark-005.f003.jpg` and never changes again (well before the
  item's auto-advance); no placeholder; the item's own line still shows.
- RESULT (PASS, 2026-10-31): driver step 8: first frame
  `spark-005.f000.jpg`, `src` advanced within the 8 fps window, and at
  ~1.1 s and ~1.5 s both samples read `spark-005.f003.jpg` — stopped on
  the final frame. Text in the overlay, no placeholder element.

### 9. Video: poster paints first, then muted autoplay

- Action: advance to item 6 (intro-006, 2 s video).
- Expected: ONE `<video id="visual-video" muted playsinline>` element,
  `poster="intro-006.poster.jpg"` with the poster also set as its CSS
  background so first paint is instant; it plays (not paused,
  `currentTime` advances). Its next item is `text`, so the chain rule
  applies from the first frame: `loop === true`, `ended` ignored.
- RESULT (PASS, 2026-10-31): driver step 9: element present with
  `src=intro-006.mp4`, poster attribute and poster background set,
  `loop=true`, `paused=false`, `currentTime` advancing, `readyState=4`;
  zero console output. The step stashes an expando on the element for
  steps 10-13. A chain video loops and never fires `ended`, so the
  standalone pass-complete→`mediaEnded` gate is walked at steps 27-28
  (the shared clip's two ranges) and its arithmetic unit-tested in
  `machine.test.ts`.

### 10. Text item keeps the video playing (same element)

- Action: advance to item 7 (line-007, a `text` item).
- Expected: per `machine.visualIndex()`, the visual is still intro-006 —
  the SAME `<video>` element (expando intact), still playing and
  looping — never a placeholder; the image element stays hidden; the
  overlay shows Mei and "The street glowed under the awning." That line
  is spoken dialogue, so `data-mode` reads `speech` on the band and on
  `#overlay-text`, and its computed `font-style` is `normal`.
- RESULT (PASS, 2026-10-31): driver step 10: expando identity
  confirmed (`sameElement=true`), `loop=true`, `paused=false`, no
  placeholder, hidden image; speaker and line correct; and
  `mode=speech/speech fontStyle=normal`.

### 11. line-007 → line-008 does not touch the video element

- Action: advance to item 8 (line-008, another `text` item in the
  chain).
- Expected: the chain advance must not re-create or reload the visual:
  same `<video>` element identity (asserted via the stashed expando),
  still looping and playing; overlay shows the line, no speaker.
  line-008 carries `thought: true`, so `data-mode` reads `thought` on the
  band and on `#overlay-text`, and the computed `font-style` is `italic`
  — the distinction the README promises, over the same playing video.
- RESULT (PASS, 2026-10-31): driver step 11: `sameElement=true`,
  `loop=true`, `paused=false`, `currentTime > 0`; overlay text exact,
  no speaker element; `mode=thought/thought fontStyle=italic`.

### 12. `h` over a playing video

- Action: press `h` while line-008 (a thought) shows over the looping
  video.
- Expected: `#overlay` becomes `[hidden]`; the video keeps playing on
  the same element, untouched. `h` hides the thought mode exactly as it
  hides dialogue (step 6 hides a spoken line), and the mode attribute
  stays whatever the line was — hiding changes presentation, not mode.
- RESULT (PASS, 2026-10-31): driver step 12: `overlayHidden=true` with
  `data-mode` still `thought` on band and line, while
  `sameElement=true`, `paused=false`; `h` again restores the overlay
  before the walk continues.

### 13. Wheel up rewinds; the video shows its poster as a still

- Action: roll the wheel up twice, one notch each time, from line-008.
- Expected: each notch steps back exactly one item — line-007, then
  intro-006 itself — and rewinding onto the video shows its poster as a
  still: paused at `currentTime` 0, `loop` off, poster still painted,
  never re-created. Media never plays on rewind.
- RESULT (PASS, 2026-10-31): driver step 13, driven by two real CDP
  `mouseWheel` events (`deltaY` -100): after the first notch the overlay
  held line-007, after the second intro-006's own line — so one notch
  moved one item. Observed on the video: `sameElement=true`,
  `paused=true`, `currentTime=0`, `loop=false`, poster background still
  set. One ceiling stays definitional rather than technical: the poster
  IS the video's first frame per docs/content-format.md, so poster-vs-
  frame-0 pixels cannot be told apart by looking; what this step can
  prove, and does, is the paused-at-zero state and the poster wiring.

### 14. One notch from an image item is one item

- Action: with window-004.jpg (an image item with text) showing, roll up
  one notch.
- Expected: exactly sunset-003 (the bare image before it) shows — the
  overlay goes empty and hidden. A notch that double-stepped would land
  on lantern-002 instead.
- RESULT (PASS, 2026-10-31): driver step 14: `window-004.jpg` + Theo's
  line → one notch → `sunset-003.jpg`, `overlayHidden=true`, overlay
  children 0.

### 15. The wheel clamps at both ends

- Action: roll up three more times past item 0, then roll down ten
  times.
- Expected: past the first item nothing moves — item 0 (meadow-001)
  stays; on the way back the wheel returns through seen items and stops
  at the frontier, never entering unseen content.
- RESULT (PASS, 2026-10-31): driver step 15: after three extra up
  notches the DOM still showed meadow-001.jpg with Mei's line. Seven
  down notches brought line-008 back (the last item ever shown, and the
  video resumed playing there, since at the frontier edge media plays
  again). Three more notches changed nothing: the overlay kept
  line-008 and `pier-009.jpg` was never painted, so no unseen item was
  entered.

### 16. `tab` skips, and stops on the first unseen item

- Action: wheel back four items to window-004, then press `tab` and
  touch nothing.
- Expected: the cursor advances one item per `settings.skipDwellMs`
  (120 ms) with no further input, media shown as stills; the mode ends
  when the cursor moves onto the first never-shown item, which is then
  shown normally — no more 120 ms cadence, its own hold applies.
- RESULT (PASS, 2026-10-31): driver step 16 (state sampled from the
  driver every ~40 ms, which also keeps the renderer ticking): from
  Theo's line the visible state moved 5 times with no input, median
  dwell 127 ms against the 120 ms setting; the frontier item
  `pier-009.jpg` appeared at +641 ms, decoded, with the overlay hidden
  (that item has no text), and the last five samples were identical —
  the cadence really stopped there. Its own 1500 ms hold then advanced
  the walk to line-010, which is the normal timing resuming on the
  frontier item.

### 17. Space during skip exits skip mode

- Action: wheel back to intro-006, press `tab`, and press space while
  the cursor is moving.
- Expected: space leaves skip mode and settles the item under the
  cursor — no further movement.
- RESULT (PASS, 2026-10-31): driver step 17: before the press the state
  had changed twice in ~320 ms (skip running); after it, zero changes in
  ~500 ms, where a 120 ms dwell would have moved ~4 more times. It
  stopped on line-008, inside seen content, so a continuing skip would
  have moved on from there. The press neither moved nor skipped past the
  item.

### 18. `e` returns to the last seen item

- Action: wheel back two items from wherever skip left the cursor, then
  press `e`.
- Expected: the cursor jumps to `frontier - 1`, the last item ever
  shown — the spot the reader resumes from. The wheel cannot push past
  it from there. The line there (line-010) is spoken dialogue with a
  speaker, so `data-mode` reads `speech` on band and line and the
  computed `font-style` is `normal`.
- RESULT (PASS, 2026-10-31): driver step 18: after two back notches the
  overlay held intro-006's line; after `e` it showed `pier-009.jpg` with
  Theo's "The tide took the last of the crates by morning." — line-010
  (item 9), the last item the walk had ever shown, painted with item 8's
  image because a `text` item keeps the earlier visual;
  `mode=speech/speech fontStyle=normal`. One further
  wheel-down left it exactly there: the frontier edge holds, and item
  10 was never entered.

### 19. A thought line reads apart from the spoken one, over a still

- Action: press space from the line `e` landed on (line-010) to enter
  the last item of the demo, line-011, which carries `thought: true`.
- Expected: the band and `#overlay-text` both say `data-mode="thought"`,
  the computed `font-style` of the line is `italic`, and the text is
  line-011's own; the visual does not move — a `text` item shows the
  nearest earlier media item's, so `pier-009.jpg` stays painted, decoded
  and visible (the same `machine.visualIndex()` rule step 10 pins for the
  video chain). `h` hiding both modes is steps 6 and 12.
- RESULT (PASS, 2026-10-31): driver step 19: `mode=thought/thought
  fontStyle=italic` over `pier-009.jpg` with `decoded=true,
  visible=true`, while the spoken line it followed read
  `speech/normal` (step 18). Both modes therefore appear over both kinds
  of visual: line-008 over the looping video (step 11), line-011 over a
  still.

### 20. `b` appends bookmarks, twice, at different items

- Action: from line-011, wheel back three items to line-008 and press
  `b`; wheel forward three items back to line-011 and press `b` again.
  (The two presses must sit on different items, so the list holds two
  distinct entries.)
- Expected: each press flashes the `#flash` "Bookmarked" pill, which
  fades away within ~1.4 s; the player's IndexedDB holds one record per
  press, in insertion order, each `{id, timestampMs, itemIndex}`. The
  thumb is opportunistic: over `file://` Chrome taints the canvas, so
  `thumbDataUrl` is null and that is the expected fallback, not a
  failure.
- RESULT (PASS, 2026-10-31): driver step 20: the pill appeared twice and
  was removed; IndexedDB held exactly two records, items 7 and 10 in
  press order (`hasThumb=false,false`, timestamps > 0). Over http the
  same code stores a JPEG data URL (capture + storage paths are
  unit-tested; `render/capture.ts`, `storage` contract suite).

### 21. `t` opens the bookmark list: oldest first, scrolled to the newest

- Action: press `t`.
- Expected: the `#bookmarks` panel covers the screen. The scroll list
  shows entries top-to-bottom OLDEST first — storage returns insertion
  order, and that order is the visual order — so the newest sits at the
  bottom, and the list is scrolled to its bottom with the most recent
  entry visible. Each entry shows a thumbnail (the stored capture, or
  the manifest still of the content that was visible at that item), the
  timestamp as `YYYY-MM-DD HH:MM:SS`, and the item index plus id. While
  the panel is open the timeline is suspended: space, `tab`, `e` and the
  wheel must not move the cursor behind it.
- RESULT (PASS, 2026-10-31): driver step 21 (viewport shrunk to 800x180
  first so two entries genuinely overflow, making "scrolled to the
  bottom" assertable): entries `[7, 10]` top-to-bottom (oldest first),
  `scrollTop=15` of max 15 with the newest entry fully visible; thumbs
  both decoded (`intro-006.poster.jpg` for the line-008 bookmark,
  `pier-009.jpg` for line-011 — the still of the content that was on
  screen, via the same visual rule as `machine.visualIndex()`, because
  the `file://` captures were null); times like `2026-10-31 17:29:41`,
  labels `#7 line-008`, `#10 line-011`; while open, space + tab + a
  wheel-up notch changed nothing in the DOM behind the panel and the
  panel stayed open; viewport then restored to 800x600.

### 22. Clicking an entry continues the novel from that item

- Action: with the panel open, click the OLDER entry (item 7, at the
  top).
- Expected: the panel closes; the cursor lands on item 7 — line-008 over
  the intro-006 video, its chain visual — UNSETTLED, so its hold plays
  and auto-advance continues the novel from there (README: "continues
  the novel from that time point"). The frontier does not move, so `e`
  still works afterwards and returns to `frontier - 1` (line-011). One
  space after the click settles the re-shown line in place rather than
  moving past it — the arrival really was unsettled.
- RESULT (PASS, 2026-10-31): driver step 22: a trusted click on entry
  `#7` closed the panel (`bookmarksOpen=false`) and the player showed
  line-008 over the video; one space held it in place (a settled
  arrival would have moved to pier-009); `e` then landed on
  `pier-009.jpg` with line-011 — frontier - 1 exactly where the walk
  left it, so `goTo` moved the cursor only inside seen content.

### 23. Closing: backdrop click, Escape, or `t` again

- Action: press `t` again to reopen (the list re-reads from storage on
  every open); click the panel's title strip (backdrop, outside the
  list); reopen and press Escape; reopen and press `t`.
- Expected: every route closes the panel. One fullscreen caveat: while
  fullscreen, Chrome reserves Escape for leaving fullscreen and the page
  never sees that keydown (a document capture listener observes nothing
  and `fullscreenElement` goes to null) — the second Escape reaches the
  page and closes the panel. Out of fullscreen (and for later overlays
  opened when not fullscreen) Escape closes on the first press.
- RESULT (PASS, 2026-10-31): driver step 23: reopen showed the 2 entries
  again; the backdrop click closed; the first Escape left fullscreen
  (`fullscreenElement` → null) with the panel open, the second closed;
  a second `t` press closed.

### 24. Reload resume

- Action: wheel back two items (to bare pier-009, mid-content), then
  reload the page (⌘R).
- Expected: the player comes back at the last seen item — `frontier - 1`
  (line-011 over pier-009), the same spot `e` lands on — not at the
  wheel position and not at item 0.
- RESULT (PASS, 2026-10-31): driver step 24: stopped mid-content on
  pier-009 (overlay hidden), the reload resumed at line-011 over
  `pier-009.jpg` — settled, the last item ever shown — and item 0 was
  ruled out. The frontier is persisted (debounced writes plus
  visibility/pagehide flushes, main.ts); bookmarks, settings and the
  resume position share the one per-novel storage namespace.

### 25. `c` opens the config screen: current values, suspension, closing

- Action: press `c` (after step 24's reload, so this first key also
  enters fullscreen); click the skip-all switch; click the panel's title
  strip (backdrop); press `c` twice more.
- Expected: `#config` covers the screen (z-index 5, under the `#flash`
  pill, like the `t` panel) with exactly two controls — the reading
  speed and skip-all — and nothing else. The readout shows the current
  multiplier and its per-character allowance, `1.00x — ~60 ms/char` for
  the default, and the switch reads `Off` (`aria-pressed="false"`).
  While the panel is open the timeline is suspended by the same gate as
  `t`: space, `tab`, `e` and the wheel must not move the cursor.
  Clicking the switch flips it to `On` and the value is live at once;
  a backdrop click closes; `c` reopens showing the value now in force,
  and `c` again closes.
- RESULT (PASS, 2026-10-31): driver step 25: readout `1.00x — ~60
  ms/char`, skip-all `Off`/`false`; space + tab + e + a wheel-up notch
  changed nothing in the DOM behind the panel; the switch click read
  back `aria-pressed=true` / `On`; the backdrop click closed; `c`
  reopened showing `true` and `c` closed again.

### 26. A changed setting applies live and survives reload

- Action: `c`, four clicks on the speed stepper's `+`, close by Escape,
  roll one wheel notch back onto line-010 and watch it without
  touching; reload; open `c` again; then set both controls back to
  their defaults (four `−` clicks, the switch, backdrop close).
- Expected: the readout moves `1.00x — ~60 ms/char` → `2.00x — ~30
  ms/char` while the panel is open. The first Escape is the browser's
  (it leaves fullscreen, panel stays open), the second closes — the
  step-23 caveat again. WITHOUT any reload, line-010's auto-advance now
  comes at ~1500 ms instead of 2880 ms: 48 code points at 2.00x is
  1440 ms, floored by the 1500 ms minHold — machine.setSettings
  re-armed the pending hold as if the new speed had held since the item
  began. After reload the player still resumes at line-011 (the
  frontier did not move), and `c` opens showing `2.00x` and skip-all
  ON: the persisted `settings` ride in the same per-novel record as the
  frontier, merged over the defaults at machine construction, written
  with the same debounce-and-flush rule (main.ts). Resetting afterwards
  keeps the steps below on default behaviour.
- RESULT (PASS, 2026-10-31): driver step 26: the stepper took the
  readout to `2.00x — ~30 ms/char` by four trusted clicks; the first
  Escape left fullscreen with the panel open, the second closed; the
  measured line-010 hold was 1408 ms (sampling-quantised ~1500 ms floor
  — at the old 1.00x its 2880 ms would show no move inside the 2600 ms
  window); after reload the player resumed at line-011 and `c` showed
  `2.00x` with skip-all `true`; the reset closed back at `1.00x`/`Off`.

### 27. Range 1 of a shared clip: part-012 plays [0, 1] once, pass via rVFC

- Action: press space once from step 26's reload landing (line-011,
  settled) to enter item 11 — part-012, a bare visual that plays
  [0.0, 1.0] of the shared `clip-012.mp4` with `loopCount: 1`. The
  driver installs an `ended` capture counter AND a
  `requestVideoFrameCallback` sampler (on the first `play` the video
  element ever fires) before the key press, so the FIRST presented frame
  after entry is recorded.
- Expected: the element plays muted with `loop=false` (a ranged video
  must never loop=true — the element's own loop would seek to 0, not
  `startSeconds`); the first presented frame is at/after 0 and
  `mediaTime` stays inside [0, 1]; the pass completes when a PRESENTED
  frame shows `mediaTime >= endSeconds` — rVFC, exact per frame — and
  that report is what satisfies the item's media gate; no native
  `ended` can fire during this phase (the pass ends before the file
  does); the machine then advances to part-013, marked by the poster
  attribute flipping to part-013.poster.jpg (the second item's poster —
  the frame at ITS startSeconds). OBSERVED start offset, frame
  containment, and pass-complete overshoot are recorded, not asserted
  frame-exact (see "Measured boundary guarantee").
- RESULT (PASS, 2026-10-31): driver step 27:
  `requestVideoFrameCallback` available=true; first presented frame
  `mediaTime=0.000` with element `currentTime=0.014` at that callback
  (OBSERVED start offset +0.000 s); 26 frames, all inside [0, 1]; pass
  completed OBSERVED at `mediaTime=1.000` — +0.000 s past `endSeconds`
  1.0 (bounded by the 0.04 s frame cadence, not by a frame-exact
  claim); `loop=false`; native `ended` from clip-012 during the
  phase=0; the machine advanced to part-013 after its single pass report
  + 1500 ms min-hold (poster flipped, observed). Console contributed
  nothing.

### 28. Range 2 on the SAME file: part-013 plays [1, 2], loop-back at 1.5

- Action: step 27's machine advance enters item 12 automatically —
  part-013, the same `clip-012.mp4` at [1.0, 2.0] with `loopCount: 2`
  and `loopStartSeconds: 1.5` (docs/plan.md Phase 9d). Watch until the
  item settles.
- Expected: the renderer re-enters the SAME `<video>` element on a new
  item (same file): poster flips to part-013.poster.jpg, playback seeks
  to `startSeconds` 1.0, passes count from zero. Because `endSeconds`
  equals the file's duration, no frame is ever presented at or past 2.0,
  so the pass boundary is the file's own `ended` — the honest exact
  signal there (rVFC would wait for a frame that cannot exist) — and the
  `ended` counter doubles as the pass-report counter: exactly 2. Between
  them the element seeks back to `loopStartSeconds` — 1.5, NOT the range
  start 1.0: the pre-roll [1.0, 1.5) plays once — and plays on; after
  the second it holds near 2.0 (`loop=false` throughout, so no third
  pass). The machine moves on only after BOTH reports plus its time
  bound, now firstPass 1.0 + loopPass 0.5 = 1.5 s; as the last item,
  that advance is a settle in place (step 24 records it; the gate
  arithmetic is pinned by `machine.test.ts`). OBSERVED start offset and
  loop-back landing (vs 1.5) are recorded.
- RESULT (PASS, 2026-10-31): driver step 28: 37 presented frames, all
  inside [1, 2]; entered at OBSERVED `mediaTime=1.000` (+0.000 s from
  `startSeconds` 1.0); exactly one loop-back, landing OBSERVED
  `mediaTime=1.520` (+0.020 s from `loopStartSeconds` 1.5 — the first
  presented frame at or after it; 1.5 itself is not a 25 fps frame time;
  NOT 1.0, so the pre-roll played once); pass reports = 2 of 2 (native
  `ended` from clip-012, the boundary source this range selects); the
  second left the element OBSERVED `paused=true, currentTime=2.000,
  loop=false` near 2.0 and a 350 ms tail showed no third pass. Console
  contributed nothing.

### 29. Empty folder shows the empty state; `t` there says no bookmarks yet

- Action: open `.tmp/verify-demo-empty/index.html` (dist stub manifest,
  no items), then press `t`.
- Expected: `#empty-state` reads "No content yet — this folder has an
  empty manifest."; no overlay; no errors. `t` opens the same panel with
  its empty message "No bookmarks yet — press b" — this folder has no
  bookmarks of its own (storage is keyed per novel folder, so the demo
  folder's two are another novel's). Escape (after the fullscreen-exiting
  one) closes it.
- RESULT (PASS, 2026-10-31): driver step 29: notice text exact, overlay
  hidden, zero console output; the overlay opened with `entries=0` and
  exactly the empty message, and Escape closed it.

### 30. Media fills the screen with its own aspect ratio

- Action: open the demo folder at a viewport that matches nothing —
  the driver sets 700x1000, portrait — and open `.tmp/verify-demo-tall`
  (item 1's image rescaled to 640x960, manifest still 960x540) at
  1200x700.
- Expected: the media box is the viewport, and the media painted in it
  is the largest centred contain fit of the ASSET's aspect ratio: flush
  with the viewport in one dimension, letterboxed in the other, centred.
  The manifest's display width/height take no part — with the 2:3 image
  on a 16:9 manifest the fit must follow the image. The overlay stays a
  band across the full viewport width, over the content and its
  letterbox rather than inside it; `h` still hides it (step 6).
- RESULT (PASS, 2026-10-31): driver step 30: at 700x1000 the 960x540
  image fills 700x393.8 at y=303.1 — flush in width, letterboxed top and
  bottom, centred; at 1200x700 the 640x960 image fills 466.7x700 at
  x=366.7 — flush in height, pillarboxed, centred — while the manifest's
  own aspect would have given 1200x675, so the fit came from the asset.
  Both pages: media box = viewport, `object-fit: contain` at
  `object-position: 50% 50%`. Overlay band 1200px of 1200px, bottom
  flush, wider than the 467px pillarboxed media. Geometry expectations
  come from the same `containFit` the unit tests pin
  (`render/fit.test.ts`); the black bars themselves are CSS paint and are
  not pixel-sampled headless — on a real screen they should sit outside
  the media, top/bottom or left/right.

### 31. Console stayed empty throughout

- Action: watch DevTools' console through the whole walk (all folders).
- Expected: zero console messages and zero uncaught errors; a plain
  `file://` open logs nothing, per the shell's own console contract. An
  autoplay rejection must be caught, never surfaced.
- RESULT (PASS, 2026-10-31): driver step 31: zero console messages,
  zero page errors, every page, whole run — including the wheel events,
  the skip runs, the bookmark presses, the overlay opens and clicks, the
  config screen's toggle, stepper, measured live hold and second reload,
  the reload and both geometry viewports, and the two range items' playing
  passes with their seek-backs.

## Not covered yet

- The contain fit is measured on the shared `<img>` (image items and
  animation frames). The `<video>` carries the same `.visual` class and
  rule — `render/fit.test.ts` fails if the CSS stops being a
  viewport-sized `object-fit: contain` box, or if the renderer takes a
  size from the manifest again — but its box is not measured at an
  oddball viewport here, and no step resizes the window mid-playback to
  watch a running video re-fit.
- What the two modes should look like. Steps 11 and 19 assert
  `data-mode` and the computed `font-style`, which pins only the current
  placeholder distinction: thought italic, dialogue upright. The final
  look is an open iteration with the user (docs/plan.md Phase 7b,
  "Deferred"); changing it is a CSS edit in `index.html`, and those two
  steps plus step 12 (`h`) are where a new look gets checked.
- The `t` list and the `c` controls are walked by mouse, the way the
  README describes them. Entries and settings controls are real buttons
  (the settings ones carry hover and focus-visible styling), but Tab is
  intercepted for skip — and suspended while a panel is open — so
  keyboard focus traversal of either panel is not exercised here.
- A data-URL thumbnail in the `t` list: over `file://` the capture is
  taint-blocked, so steps 21-23 walk the manifest-still fallback. The
  data-URL branch is pinned by `render/bookmarks.test.ts`
  (`entryThumbSrc`), and the JPEG itself by the Phase 8 capture and
  storage suites; a walk over `http://` showing a real captured thumb
  is a cheap extra.
- Skip with `skip_all` on (skipping through unseen content, marking it
  seen, and ending at content end): machine-tested, mid-skip setting
  changes included (`machine.test.ts`, `setSettings`). The setting
  itself now lives on the `c` screen and steps 25-26 toggle, apply and
  persist it, but no step runs a full skip-through with it on
  mid-novel — that would consume unseen content and move the later
  steps' resume point.
- The `timeupdate` range-boundary fallback: this Chrome has
  `requestVideoFrameCallback`, so steps 27-28 walk the rVFC path (and
  the `ended` path where the range runs to the file's end). The fallback
  for browsers without rVFC — `timeupdate`-bounded passes, ~4-250 ms
  coarse, noted once on the console — is the pure boundary choice in
  `videoPlanFor` (`render/visual.test.ts`); a walk on Firefox pre-133
  is a cheap extra.
- A trackpad's small, rapid deltas: the driver sends one 100 px notch,
  which is a mouse wheel. The accumulator's threshold, rate cap and
  direction-flip rules are unit-tested (`render/wheel.test.ts`), not
  walked here; a human walk with a trackpad is a cheap extra.
- The `holdSeconds` background-video path in a real browser: the demo
  fixture has no `holdSeconds` item, so steps 27-28 walk only the finite
  `loopCount` path (ranged). The decision for the other path — `loop` on, no
  `ended` ever reported, machine driven by the clock alone — is pure and
  pinned in `render/visual.test.ts` (`videoPlanFor`) and
  `machine.test.ts`. A real-browser walk of an unplayable-video fallback
  (autoplay rejection → poster still → machine still advances) is
  likewise unit-covered only.
