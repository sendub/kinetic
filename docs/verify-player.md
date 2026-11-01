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
continues the novel from that time point — since Phase 13 through the
route-play context recorded with the bookmark — and the reading state
survives a reload and an `e`-verified bookmark jump — since Phase 14
that state record is written on the change itself (no debounce window is
left to lose it in), and the flash arrives only once BOTH the bookmark
and the state write have committed, which is what step 39 walks with a
reload issued the instant the pill appears; the Phase 9 config
set: `c` opens the config screen showing the current reading speed,
skip-all, and (Phase 13) play-all-routes state, its controls change the
settings live — a measured
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
map today holds space, `h`, `tab`, `e`, `b`, `t`, `c`, `a`, Enter and
Escape (Phase 13b), plus the 1..9 route digits of a pending decision
(Phase 13); the wheel has its own module (`render/wheel.ts`), because a
wheel event is not a key. While the `t` or `c` overlay is open the
cursor-moving commands (space, `tab`, `e`, wheel) are suspended — the
overlay takes precedence; `b` and `h` keep working. The `#help` screen
(Phase 13b) pauses the machine behind a black page; a pending branch
decision (the `#choice` overlay, Phase 13) owns the input — digits,
Enter with the return offer, row clicks — and suspends the timeline,
with only help allowed to open over it. The Phase 13 branch fixture —
24 items, `bridge-015`'s decision with a continuing `hire` route and an
ending `refuse` route rejoining at the `main-023` aftermath, and a
nested decision on `hire-017` inside `hire` — is walked end to end by
steps 32-38: the overlay opening on the settle, the ending route's
reselection with its seen marker, the nested decision and the
`continueAt` rejoin, resume inside branch content, the seen-aware `e`
into the never-taken route, and `Play all routes` through a skip-all
burst. Its row model, input precedence and Enter rule are pinned by
`render/choice.test.ts`, the route digits by `render/keys.test.ts`, and
`Play all routes` defaults off in the `c` screen (walked at step 25).
The Phase 16 walk rules — one press advances exactly one step, wheel and
tab-skip arrivals SHOW an unresolved decision's overlay (skip pauses
there; the pick resumes manual), the Return row is re-offered once any
route completed, `e` shows the ENDING once all is seen, and config's
"Reset progress" restores the first-ever play — are walked by steps
42-44 and reflected in the reworded entries 3, 27, 33, 34, 37 and 40.

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
that tells the asset's aspect ratio apart from the manifest's — plus a
blank same-origin page in the demo folder that step 38's storage wipe
runs from (a delete issued while any app tab still holds the IndexedDB
connection never completes, and `about:blank`'s opaque origin refuses
IndexedDB), then drives every step below and prints `PASS`, `PARTIAL`,
or `FAIL` per step.
The Chrome profile is wiped before launch: IndexedDB holds the reading
state and the bookmark list (since Phase 13 the state record is the
machine's route-play ctx, with `frontier` a derived legacy field), and
a run must start from the first-ever-load state a fresh machine has. Every input is real CDP Input:
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
first-ever load on item 1's image, untouched by the seen edge the main
walk persisted (steps 27-28 push that edge onto part-013, a video —
and since Phase 13 the still-running auto-advance walks it on through
the branch lead-in while steps 29-31 run elsewhere).
Exit code is 0 when
every step is PASS or PARTIAL, 1 on any FAIL.

To walk it by hand instead: run `node scripts/verify.mjs` once (or
assemble the folder yourself per CREATE.md § Playing the folder), open
`.tmp/verify-demo/index.html` in Chrome with DevTools' console open, and
press keys. One machine fact keeps the manual walk predictable: in
manual mode one space press is one step — the press ends the current
item's wait and moves on the same press (docs/plan.md Phase 16) — while
in auto-forward a press only ends that wait where it stands and the next
press moves on. For the wheel, one notch — any event of ~8 px and up —
steps exactly one item, and a fast flick is priced at 100 px per step;
steps are capped at ~12 per second, so a flick cannot outrun the eye.
(The driver walks this rule since the Phase 16 rework: its manual-mode
steps press once per move.) For step 29, drag the window to a
shape that matches nothing — tall and narrow, or wide and short — and the
media should stay flush with one pair of edges, centred on the other
axis, with black only where the asset's aspect and the window's differ.
For step 19, the demo's two thought lines — line-008 over the looping
video, line-011 over the pier still — should read italic, and every other
line upright. For steps 20-23 press `b` at two different items (wheel
back once in between), `t` to see the list at the bottom, click the
older entry, `e` to step onto the first unseen item; note the first
Escape belongs to the browser
while fullscreen (it leaves fullscreen), so the overlay's second Escape
is what closes it. For steps 25-26 press `c` for the config screen,
click the stepper's `+` and the skip-all switch to change settings live
(the play-all-routes switch is flipped the same way, and back to off
before the walk continues), close with backdrop, `c` or the second
Escape, and reload to see the
changed values read back at startup (set them back afterwards, or the
next manual walk starts at the reader's own pace — which is the point).
For steps 27-28 advance to the demo's two range items — mid-story since
Phase 13, not the last ones — which share one
2 s clip at different ranges: part-012 should show the clip's first half
once and move on; part-013 (`loopStartSeconds: 1.5`) should show [1, 2],
snap back to 1.5 s — not to 1 s — show the rest once more, then hold
near the end: a 1.0 s pass then a 0.5 s pass, no third pass, and `loop`
never checked anywhere on the element. For steps 32-38 keep walking
past part-013: the lead-in image, a line, then `bridge-015` — settling
it opens the decision overlay and NOTHING advances, whatever auto-forward
is doing; press `2` to take the ending route (`refuse-019`'s own image,
its ending line, then the overlay comes back with `refuse` marked seen
and — since Phase 16 — the "Return to main route" row offered), press
`1` to take `hire` (`hire-016`/`hire-017`),
where settling `hire-017` opens the nested overlay — `1` plays `late-021`
and its end rejoins at `hire-018` on its own; stepping off `hire-018`
lands on the `main-023` aftermath directly (the continuing route's end
is not a reselection point), and `main-024` closes the path; a reload
then comes back on `main-024` with no overlay, `e` jumps to `early-022`
— the one line never played — and with everything seen another `e`
shows the ENDING (Phase 16: the most recently seen ending, the array
end here; pressing again there stays put); a clean slate with `c`'s
skip-all and play-all-routes both on runs the WHOLE story on one `tab`
press, every route once, the continuing route last, and no overlay
anywhere (play-all remains the no-pause path). For
step 39, start from a clean slate, walk to `window-004`, press `b`, and
reload the MOMENT the "Bookmarked" pill appears — do not wait first: the
page must come back on that same line, and `t` → the newest row must
lead back to it too.

Results below were walked on 2026-10-31 by the driver on headless
Chrome 156.0.8078.76, re-walked on 2026-11-01 after the Phase 13
resync, and again after the branch fixture joined the demo — both later
re-walks multiple runs with the same statuses, once more on
2026-11-01 with the Phase 14 persistence fix and its step 42, and on
2026-11-01 as the Phase 16 close-run with the one-press driver and its
three new steps — now 47 driver steps: 46 pass, 1 honest partial (the evidence lines differ run to run only in
bookmark timestamps, sampled video `currentTime`, boundary measurements
and range-frame counts, skip-dwell timings, the hold measurement, the
branch change log's positions, and per-event video timestamps). The headings keep the checklist's own numbering; the
entries reworded for the Phase 13 seen/jump semantics — the wheel clamp,
skip's stop, `e`, the bookmark click, the reload resume and the config
screen — re-record their results on 2026-11-01 under the driver's
current step numbers; the entries reworded for the Phase 16 walk
semantics (3, 27, 33, 34, 37, 40) and the new Phase 16 entries 42-44
re-record theirs on 2026-11-01, and entries not reworded keep the numbers
they were recorded under. The fit rule in step
30 is pinned twice over: the pure `containFit` in `render/fit.ts` is
unit-tested, and the driver imports that same function as its expectation,
so the two cannot drift. The `t` list's pure rules (order,
scroll-to-bottom, timestamp, thumbnail fallback) are unit-tested in
`render/bookmarks.test.ts`, and the overlay's precedence rule
(`suspendTimeline`) in `render/keys.test.ts`. The decision overlay's pure
rules (the row model from a `ChoiceView`, the input-owner precedence
help > choice > story, the Enter rule, the route digits and their help
row) are unit-tested in `render/choice.test.ts` and
`render/keys.test.ts`. The `c` screen's pure rules
(speed stepper steps and clamps, the readout text) are unit-tested in
`render/config.test.ts`, the live-change semantics of `readingSpeed` and
`skipAll` in `machine.test.ts`, and the settings' storage round-trip in
the `storage.test.ts` contract suite. The Phase 14 write
policy — a change issues its state write immediately, and a snapshot
superseded while one is in flight replaces the pending one instead of
queueing behind it — is unit-tested in `storage/persist.test.ts`. The
range-plan rules (entry start,
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
- OBSERVED since the branch fixture made part-013 mid-story: its last
  pass report advances the machine INSIDE the same `ended` event, and
  the renderer's counter reset under its own handler lets the hidden
  element replay [1.5, 2.0] once before resting (entry 28; reported,
  engine untouched). The step's arithmetic counts only what happened
  while the item was on screen.

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

- Action: press space once — in manual mode one press is one step
  (Phase 16; the old settle-then-move pair is gone).
- Expected: item 2 (lantern-002.jpg) shows with its line on that single
  press; no speaker element, since that item has none.
- RESULT (PASS, 2026-11-01): driver steps 3-4: item 1 held its full
  2400 ms hold untouched (manual is the default), `a` then advanced it
  on a fresh hold and `a` again cancelled mid-item; after a wheel-back,
  one press showed the lantern image decoded with its text and no
  `#overlay-speaker`. Steps 45-46 pin the 1:1 rule on fresh pages.

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
  at the highest item ever shown — one below the seen edge — never
  entering unseen content (Phase 13: seen-ness is the per-item visited
  set, and the wheel's ceiling is the highest item shown in any route;
  on a first play-through that is exactly the old frontier rule).
- RESULT (PASS, 2026-11-01): driver step 16: after three extra up
  notches the DOM still showed meadow-001.jpg with Mei's line. Seven
  down notches brought line-008 back — the highest item ever shown —
  and the video resumed playing there (arriving back onto a seen item
  plays its media normally). Three more notches changed nothing:
  `pier-009.jpg` (item 8, the next unseen item) was never painted, so
  nothing unseen was entered.

### 16. `tab` skips, and stops on the first unseen item

- Action: wheel back four items to window-004, then press `tab` and
  touch nothing.
- Expected: the cursor advances one item per `settings.skipDwellMs`
  (120 ms) with no further input, media shown as stills; the mode ends
  when the cursor moves onto the first never-shown item — the visited
  set's first gap along the path, which on linear content is the old
  frontier item — and that item is then shown normally: no more 120 ms
  cadence, its own hold applies.
- RESULT (PASS, 2026-11-01): driver step 17 (state sampled from the
  driver every ~40 ms, which also keeps the renderer ticking): from
  Theo's line the visible state moved 5 times with no input, median
  dwell 129 ms against the 120 ms setting; the first never-shown item
  `pier-009.jpg` — the frontier, the seen set's first gap — appeared at
  +648 ms, decoded, with the overlay hidden (that item has no text),
  and the last five samples were identical — the cadence really stopped
  there. Its own 1500 ms hold then advanced the walk to line-010,
  which is the normal timing resuming on the first-unseen item.

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

### 18. `e` steps onto the first unseen item

- Action: wheel back two items from wherever skip left the cursor, then
  press `e`.
- Expected (Phase 13 semantics — this step MOVED with the visited-set
  resync): the cursor lands ON the first never-shown item along the
  path — the spot the reading stopped at — not on `frontier - 1` as it
  did before Phase 13: on this linear walk that is item 10 (line-011),
  while the old landing (line-010) is already seen content. Arriving
  shows the item and marks it seen, so the derived frontier moves with
  it; the wheel cannot push past from there (the next item is unseen).
  The line there is the demo's thought: `data-mode="thought"` on band
  and line, the computed `font-style` `italic`, painted over item 8's
  still because a `text` item keeps the earlier visual.
- RESULT (PASS, 2026-11-01): driver step 19: after two back notches the
  overlay held intro-006's line; after `e` it showed `pier-009.jpg`
  with "We stacked the rest ourselves, and called it enough." — item
  10, the path's first never-shown item, shown now so the frontier
  moved with it — `mode=thought/thought fontStyle=italic`. One
  wheel-down after `e` left it exactly there: the next item is unseen
  and the wheel does not enter unseen content. (The pre-Phase-13 walk
  landed on line-010, item 9, `speech/normal`.)

### 19. A thought line reads apart from the spoken one, over a still

- Action: the line `e` lands on (step 18) IS the demo's last item,
  line-011, which carries `thought: true`; the driver re-reads it —
  wheel-back from wherever the walk has since moved it.
- Expected: the band and `#overlay-text` both say `data-mode="thought"`,
  the computed `font-style` of the line is `italic`, and the text is
  line-011's own; the visual does not move — a `text` item shows the
  nearest earlier media item's, so `pier-009.jpg` stays painted, decoded
  and visible (the same `machine.visualIndex()` rule step 10 pins for the
  video chain). `h` hiding both modes is steps 6 and 12.
- RESULT (PASS, 2026-11-01): driver step 21: `mode=thought/thought
  fontStyle=italic` over `pier-009.jpg` with `decoded=true,
  visible=true`, while the spoken lines it sits among read
  `speech/normal` (steps 6/18). Both modes therefore appear over both
  kinds of visual: line-008 over the looping video (step 11), line-011
  over a still. (Before the Phase 13 `e` change this step entered
  line-011 with a space from `e`'s old landing on line-010; the
  observations are unchanged.)

### 20. `b` appends bookmarks, twice, at different items

- Action: from line-011, wheel back three items to line-008 and press
  `b`; wheel forward three items back to line-011 and press `b` again.
  (The two presses must sit on different items, so the list holds two
  distinct entries.)
- Expected: each press flashes the `#flash` "Bookmarked" pill, which
  fades away within ~1.4 s; the player's IndexedDB holds one record per
  press, in insertion order, each `{id, timestampMs, itemIndex, ctx}` —
  the Phase 13 `ctx` being the route-play context captured with the
  press (seen set, decision stack, `lastShown`), the payload that lets
  step 22's restore re-enter the recorded context; a pre-Phase-13
  record lacks it and restores by `itemIndex` alone. The
  thumb is opportunistic: over `file://` Chrome taints the canvas, so
  `thumbDataUrl` is null and that is the expected fallback, not a
  failure.
- RESULT (PASS, 2026-11-01): driver step 22: the pill appeared twice and
  was removed; IndexedDB held exactly two records, items 7 and 10 in
  press order (`hasThumb=false,false`, timestamps > 0 — the driver
  prints the selected fields; each stored record carries its `ctx`).
  Over http the
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
- Expected (Phase 13 semantics): the panel closes; the player continues
  at item 7 — line-008 over the intro-006 video, its chain visual —
  UNSETTLED, so its hold plays and auto-advance continues the novel
  from there (README: "continues the novel from that time point"). The
  restore goes through the record's ctx (`bookmarkRestoreTarget` →
  `machine.importContext`): the item is re-entered within the route
  context captured with the bookmark, the seen set restored as it was
  then — on this linear story the same landing the legacy itemIndex
  navigation gives. The seen edge stays exactly where the walk left it,
  so `e` afterwards steps onto the first UNSEEN item — item 12,
  part-013's poster, since 0..11 have been shown (under the old rule it
  returned to `frontier - 1`, line-011 — seen content now). One space
  after the click settles the re-shown line in place rather than
  moving past it — the arrival really was unsettled.
- RESULT (PASS, 2026-11-01): driver step 24: a trusted click on entry
  `#7` closed the panel (`bookmarksOpen=false`) and the player showed
  line-008 over the video; one space held it in place (a settled
  arrival would have moved on); `e` then stepped onto
  `part-013.poster.jpg` — item 12, the first unseen item (0..11 had
  been shown) — the frontier exactly where the walk left it, so the
  restore moved the cursor only inside seen content.

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
- Expected (Phase 13 semantics): the player comes back at the item the
  reader left — the persisted ctx's `lastShown` (line-011 over
  pier-009) — settled, and NOT item 0, NOT the seen edge (that is what
  step 18's `e` walks to), and not wherever a frontier number alone
  would point on a gappy visited set.
- RESULT (PASS, 2026-11-01): driver step 26: stopped mid-content on
  pier-009 (overlay hidden), the reload resumed at line-011 over
  `pier-009.jpg` — an identical painted signature, still identical
  1.8 s later: the resume landed settled and the reloaded machine,
  manual by default, holds it — and item 0 was ruled out. The ctx is
  persisted (each change issues its write
  immediately, with the visibility/pagehide handlers re-issuing the
  current snapshot as belt-and-braces, main.ts); bookmarks, settings and the
  resume position share the one per-novel storage namespace.

### 25. `c` opens the config screen: current values, suspension, closing

- Action: press `c` (after step 24's reload, so this first key also
  enters fullscreen); click the skip-all and the play-all-routes
  switches; click the panel's title
  strip (backdrop); press `c` twice more.
- Expected: `#config` covers the screen (z-index 5, under the `#flash`
  pill, like the `t` panel) with exactly three controls — the reading
  speed, skip-all, and the Phase 13 play-all-routes switch — and
  nothing else. The readout shows the current
  multiplier and its per-character allowance, `1.00x — ~60 ms/char` for
  the default, and both switches read `Off` (`aria-pressed="false"` —
  play-all-routes defaults off, like skip-all).
  While the panel is open the timeline is suspended by the same gate as
  `t`: space, `tab`, `e` and the wheel must not move the cursor.
  Clicking a switch flips it to `On` and the value is live at once
  (`playAllRoutes` takes effect at the next decision; on this linear
  demo it has no decision to auto-play);
  a backdrop click closes; `c` reopens showing the values now in force
  (both switches `On`), the driver flips play-all back to `Off`, and
  `c` again closes.
- RESULT (PASS, 2026-11-01): driver step 27: readout `1.00x — ~60
  ms/char`, skip-all and play-all `Off`/`false`; space + tab + e + a
  wheel-up notch
  changed nothing in the DOM behind the panel; the switch clicks read
  back `aria-pressed=true` / `On` for both; the backdrop click closed;
  `c`
  reopened showing `true` on both, the play-all flip back to `false`
  took, and `c` closed again.

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
  began. After reload the player resumes on exactly the item the walk
  was frozen on — the ctx's `lastShown`, the seen edge unmoved — and
  `c` opens showing `2.00x` and skip-all
  ON: the persisted `settings` ride in the same per-novel record as the
  route-play ctx, merged over the defaults at machine construction, written
  on the change itself like every other field of the record (main.ts).
  Resetting afterwards
  keeps the steps below on default behaviour.
- RESULT (PASS, 2026-11-01): driver step 28: the stepper took the
  readout to `2.00x — ~30 ms/char` by four trusted clicks; the first
  Escape left fullscreen with the panel open, the second closed; the
  measured line-010 hold was 1433 ms (sampling-quantised ~1500 ms floor
  — at the old 1.00x its 2880 ms would show no move inside the 2600 ms
  window); after reload the player came back to exactly the item the
  walk froze on and `c` showed
  `2.00x` with skip-all `true`; the reset closed back at `1.00x`/`Off`.

### 27. Range 1 of a shared clip: part-012 plays [0, 1] once, pass via rVFC

- Action: on a clean slate (storage wiped, help dismissed), walk the
  first-ever boot onto line-011 with TEN single presses — one press =
  one item since Phase 16, so the count lands exactly. The driver
  installs an `ended` capture counter AND a
  `requestVideoFrameCallback` sampler (on the first `play` the video
  element ever fires) before the eleventh press, which enters item 11 —
  part-012, a bare visual that plays [0.0, 1.0] of the shared
  `clip-012.mp4` with `loopCount: 1` — so the FIRST presented frame
  after entry is recorded; auto-forward comes on after entry, and its
  gate drives the step on.
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
- RESULT (PASS, 2026-11-01): driver step 29:
  `requestVideoFrameCallback` available=true; first presented frame
  `mediaTime=0.000` with element `currentTime=0.012` at that callback
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
  and `loopStartSeconds: 1.5` (docs/plan.md Phase 9d). Since Phase 15
  auto is turned OFF on entry for the measurement (what follows is the
  `stroll-025` VIDEO chain, and its play through the same reused element
  would blur the hold), and restored at the step's end.
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
  pass). With auto off the reports alone never move the cursor (the
  ended count without a timed hold completes nothing); the gate that
  does move it — both reports plus firstPass 1.0 + loopPass 0.5 = 1.5 s
  — is pinned by `machine.test.ts`, and when the step restores auto the
  armed hold carries the walk on, through the Phase 15 chain and into
  the branch fixture's lead-in. OBSERVED start offset and loop-back
  landing (vs 1.5) are recorded.
- RESULT (PASS, 2026-11-01): driver step 30: 37 presented frames
  recorded while part-013 was on screen, all inside [1, 2]; entered at
  OBSERVED `mediaTime=1.000` (+0.000 s from `startSeconds` 1.0); exactly
  one loop-back, landing OBSERVED `mediaTime=1.520` (+0.020 s from
  `loopStartSeconds` 1.5 — the first presented frame at or after it;
  1.5 itself is not a 25 fps frame time; NOT 1.0, so the pre-roll
  played once); pass reports = 2 of 2 (native `ended` from clip-012,
  the boundary source this range selects) counted while part-013 was
  the current item — and, auto off across the measurement, the cursor
  never moved on the reports alone; the last one left the element
  OBSERVED `paused=true, currentTime=2.000, loop=false` near 2.0 with
  no hidden re-loop this run (that Phase 13 artefact appears only when
  the machine moves inside the report's own event — the step now
  restores auto after reading the hold, and the armed walk carries on
  through the Phase 15 chain). Console contributed nothing.

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
- RESULT (PASS, 2026-11-01): driver steps 33 and 41: zero console
  messages, zero page errors, every page — 33 checks up through the
  linear walk (wheel events, skip runs, bookmark presses, overlay opens
  and clicks, the config screen's toggle, stepper, measured live hold and
  second reload, the reload and both geometry viewports, the two range
  items' playing passes with their seek-backs), and 41 re-checks over
  the WHOLE run, branch steps included: the decision overlay and its
  nested twin, the ending route's reselection, the rejoin, the `e`-jump
  into the never-taken route, the resume inside branch content, and the
  play-all skip burst.

### 32. The decision opens on the settle: prompt + numbered rows, the item holds

- Action: keep walking past part-013 (auto-forward may carry this
  itself): `bridge-014`'s line over its image, then `bridge-015` — the
  decision's `after` item. Watch what settling it does.
- Expected: the FORWARD SETTLE of `bridge-015` opens `#choice` instead
  of moving: its title is the decision's prompt ("What does the studio
  decide?"), one row per route in manifest order, numbered 1..N with
  their labels ("Offer them the job", "Turn them down"), no seen markers
  and no return row (nothing has been played; the continuing route's end
  is the only return point). The settled item does not advance — with
  auto-forward ON and a 2 s wait the paint never changes and the
  overlay stays up: the pending decision owns the screen.
- RESULT (PASS, 2026-11-01): driver step 34: the decision OPENED PURELY
  ON THE AUTO-ADVANCE — no key press between part-013's gate and the
  overlay (part-013 is mid-story now, and the settle of `bridge-015`
  fires it): overlay up over `bridge-015.jpg` with its own overlay
  hidden, prompt exact, rows `[1 "Offer them the job", 2 "Turn them
  down"]`, no seen markers, no return row; 2000 ms of sampling with
  auto-forward ON changed nothing and the overlay stayed up.

### 33. The ending route plays, then the decision re-opens seen-marked

- Action: at the overlay press `2` — `refuse`, the `result: "ending"`
  route. Walk its span, then step off its end.
- Expected: the route span plays — `refuse-019`'s OWN image with its
  line and speaker, then `refuse-020`'s ending line over the same
  image; the hire route's image is never painted anywhere along the way.
  Past the route end `#choice` comes back for reselection: the played
  `refuse` row carries the seen marker, the unplayed `hire` row does
  not, and — Phase 16, "the ending-loop is escapable" — the re-open now
  OFFERS the unnumbered "Return to main route" row: once ANY route of a
  decision has completed, every re-opening carries it whenever the
  decision has a continuing route, whatever the played route's result.
- RESULT (PASS, 2026-11-01): driver step 35: digit 2 opened the span on
  `refuse-019` (`img="refuse-019.jpg"`, speaker Mei), then the ending
  line over the SAME image; the page-side change log NEVER held
  `hire-016.jpg` (the route was entered, never painted); past the end
  the overlay returned with rows `[hire: seen=null, refuse: seen="seen",
  "Return to main route" (continue)]`.

### 34. The continuing route and the nested decision: pick early, take the return row, rejoin at hire-018

- Action: at the re-opened overlay press `1` (`hire`), step to
  `hire-017`, press once more to settle it (a manual press settles the
  shown item and its move fires the decision before stepping — Phase
  16), and at the SECOND overlay press `2` (`early`,
  the nested `result: "return"` route). Step off `early-022`, then press
  Enter at the re-opened overlay.
- Expected: `hire-016`/`hire-017` play over the hire image; the FORWARD
  SETTLE of `hire-017` opens the NESTED decision's overlay — its own
  prompt ("When do they meet?") and its rows ("Late, over coffee",
  "Early, before the sun"), no return row yet — no route of THIS
  decision has completed. `early-022` then plays (over
  the hire image — its span holds no image of its own), and its end
  RE-OPENS the inner decision with the same Phase 16 re-offer step 33
  pins: the played `early` row is seen-marked, the unplayed `late` row
  is not, and the unnumbered return row closes the list. Enter answers
  it: the join lands directly on the
  `continueAt` `hire-018`, and the change log must show `early-022`'s
  line before the rejoin line with the re-opened overlay's `choice-open`
  between them. `late` stays unplayed here — it plays in the `Play all
  routes` burst of step 38.
- RESULT (PASS, 2026-11-01): driver step 36: hire route entered on
  `hire-016` (img/text/speaker); settling `hire-017` fired the nested
  overlay with the exact prompt and both rows (no return row); `2`
  played `early-022` over the hire visual; its end re-opened the overlay
  with rows `[late: seen=null, early: seen="seen", "Return to main
  route" (continue)]`; Enter landed on `hire-018` with `#choice` shut —
  log order `early-022@9 → choice-open@10 → hire-018@11`.

### 35. The continuing route's end goes straight to continueAt — once

- Action: step off `hire-018`, the outer continuing route's end.
- Expected: the aftermath `main-023` plays DIRECTLY: no overlay at the
  continuing route's end (its end is not a reselection point — the
  engine test "the continuing route proceeds to continueAt past its
  end" pins the rule), the aftermath shown exactly ONCE for the whole
  decision (the change log counts it), and the walk continues onto the
  closing line `main-024`.
- RESULT (PASS, 2026-11-01): driver step 37: stepping off the hire
  route's end landed on `main-023.jpg` with its line and speaker,
  `#choice` stayed shut; `main-023.jpg` appears 1× in the whole-page
  change log; the walk continued onto the closing line.

### 36. Reload inside branch content: resume on lastShown, no decision re-fires

- Action: on `main-024` (branch content, the walk's end), reload the
  page.
- Expected: the page comes back on EXACTLY that item — `lastShown`
  drove the landing, and the restored route-play ctx carries the played
  routes — and NO decision re-fires on load: a resume landing is not a
  forward settle of an `after` item. The landing holds: resume arrives
  settled and manual.
- RESULT (PASS, 2026-11-01): driver step 38: the paint signature was
  identical before and after the reload and 1.8 s later — same item,
  `#choice` never re-fired, help stayed closed (`helpSeen` survives).

### 37. `e` jumps to the never-taken route; with all seen it shows the ENDING

- Action: from the resumed `main-024`, press `e` three times.
- Expected: every item on the played path is seen (the visited set
  returned with the ctx), and the ONLY unseen item is `late-021` — the
  inner route never picked (`early` was, and returned, in step 34). With
  the current span all seen and no decision open, the rule-(c)
  array-order jump lands there: `late-021`'s line over the hire image,
  no overlay. The landing marks it seen, so the second press finds
  NOTHING unseen — and since Phase 16 it then shows the ENDING: the most
  recently seen ending item (here `main-024`, the array end — tracked as
  `lastEnding` the moment the cursor is placed on an ending item, and
  persisted with the ctx). A third press on that item stays put: the
  press never cycles through endings.
- RESULT (PASS, 2026-11-01): driver step 39: `e` landed on "They showed
  at ten, late and grinning." over `hire-016.jpg` — `late-021`, the
  never-taken route (the ctx's visited set came back with it, itself
  OBSERVED); the second `e` met an all-seen story and showed the
  ending — "And the tape rolled on without an answer." over
  `main-023.jpg`; a third press changed nothing.

### 38. `Play all routes` + skip-all: one burst plays every route, continuing last

- Action: clean slate (wipe storage, first-ever load). In `c` turn
  skip-all AND play-all-routes ON BEFORE the walk reaches any decision,
  close the screen, press and release `tab` once.
- Expected: the burst runs the WHOLE story with zero further
  interactivity. A decision reached mid-skip resolves in play — the
  first not-yet-played route in manifest order, the CONTINUING route
  held LAST — so `refuse` plays BEFORE `hire` and `early` BEFORE `late`;
  `early`'s end is now a completed `return` route, which play-all must
  AUTO-resolve on to `late` — the "Return to main route" row never
  surfaces in the burst; `#choice` never surfaces; every route plays
  exactly once; the aftermath follows the continuing route's end and
  the burst ends on the closing line.
- RESULT (PASS, 2026-11-01): driver step 40: clean slate with both
  switches set in `c` before the walk, one tab press ran everything;
  observed order `bridge-014 → bridge-015 → refuse-019 → refuse-020 →
  hire-016 → hire-017 → early-022 → late-021 → hire-018 → main-023 →
  main-024` (strictly increasing in the change log), so the alternates
  played before their continuing routes (engine `nextAutoRoute`, pinned
  by `branches.test.ts`) and early's completed `return` auto-resolved
  straight on to `late`; `#choice` never opened across 54 samples and
  the whole log; the burst ended on the closing line. Console stayed
  empty (step 31).

### 39. `b` then an immediate reload: the resume IS the bookmarked item

- Action: clean slate (wipe storage, first-ever load), dismiss the help,
  walk to `window-004`, press `b`, wait for the "Bookmarked" pill, and
  reload the INSTANT it appears — no waiting first. Then `t` and click the
  newest row.
- Expected (Phase 14): the page comes back on `window-004` — the position
  was committed BEFORE the pill appeared, because a change issues its state
  write immediately and the confirmation waits for the bookmark and that
  write to commit. Before the fix this reload landed on the PREVIOUS item:
  the debounced write had not been issued yet, and IndexedDB promises
  nothing about a transaction opened while the document goes away. The list
  holds exactly the one new bookmark, and its row restores the same item
  through the captured ctx.
- RESULT (PASS, 2026-11-01): driver step 42: clean slate, walked to item 3
  (`window-004.jpg`), `b` -> the pill -> reload with NOTHING in between
  (pill → new-document load took 43 ms — inside the window the 250 ms
  debounce used to lose): the page came back on `window-004.jpg` with
  Theo's line, help stayed closed, IndexedDB held 1 bookmark at item 3, and
  clicking that newest row left the screen on the same item and line; the
  console stayed empty through the writes, the reload and the click.

### 40. `minPlaySeconds`: auto leaves the chain at the floor, not the text sum

- Action: on the step-39 page, press `e` until it lands on `stroll-025`
  (each press walks the unseen frontier one item — navigation fires no
  decision); then `a` (auto ON) — a manual press now steps (Phase 16),
  so the in-place settle this measurement needs is the AUTO-mode press:
  one `space` ends the chain head's wait where it stands, another
  `space` steps on, letting auto drive the chain `stroll-025 → line-026 →
  line-027`; sample until the visual changes past the chain, then `a`
  off.
- Expected (Phase 15): the dialogue advances at reading speed UNDER the
  playing video (`line-026`, then `line-027`, video still running); the
  step LEAVING the chain waits out the video's `minPlaySeconds: 4.5`
  floor, measured from when the video item became current — the visual
  changes no earlier than ~4.5 s, where the two dialogue holds alone sum
  to ~3 s. The floor never stalls the media under the chain.
- RESULT (PASS, 2026-11-01): driver step 43: the frontier walk landed on
  the chain head; `line-026` was current at +6 ms and `line-027` at
  +1563 ms after auto took the chain, both with `stroll-025.mp4` still
  PLAYING beneath them, and the visual past the chain changed at
  +4554 ms from the video becoming current — the floor, ≥4.4 s asserted,
  where the two dialogue holds alone come to ~3 s.

### 41. `skip` through the floor chain stays immediate

- Action: wheel back before the chain (to `part-013`), press `tab`, and
  sample through the whole chain: the video poster, both dialogue lines,
  and the exit past `line-027`; then `tab` again.
- Expected: skip walks the three items in plain dwells and LEAVES the
  chain on the next dwell too — total well under 1.5 s. The floor is an
  auto-advance rule only; skip stays immediate (README), even though
  this re-entry re-bases the chain head fresh and auto would wait 4.5 s
  from it again. The video never plays in skip — posters only.
- RESULT (PASS, 2026-11-01): driver step 44: `line-026` at +259 ms and
  `line-027` at +386 ms after the tab press, the chain's exit visual at
  +516 ms (from the chain's head: 386 ms) — four 120 ms dwells, posters
  only, nothing playing; the same re-entry under auto (step 40 above)
  waited 4.5 s. Console empty throughout.

### 42. One-press advance, strict 1:1 (Phase 16)

- Action: on a first-ever page, dismiss the help; press space once, then
  three quick presses; then one wheel notch back and one forward.
- Expected: one press moves exactly one item; three presses move exactly
  THREE (not the item ~2 a settle-then-move pair would give); one wheel
  notch steps exactly one item, forward and back — the manual-mode rule
  of docs/plan.md Phase 16 ("one action means one step"), proven away
  from any stored state.
- RESULT (PASS, 2026-11-01): driver step 45, on a private first-ever
  page (its own storage): item 1 + one press -> `lantern-002.jpg` with
  its line; 3 quick presses -> `spark-005.f000.jpg` — exactly items 2,
  3, 4; wheel up one notch -> `window-004.jpg` with its line, wheel
  down one notch -> spark-005 again. Zero console output.

### 43. Decisions surface on navigation (Phase 16)

- Action: parked on `bridge-014` with the outer decision unresolved:
  press once onto `bridge-015`; wheel off it and back; wheel off again,
  press `tab`, and let the skip burst run into the decision; pick `2`
  (`refuse`) from the pause; step the ending and off its end; press
  Enter at the re-opened overlay.
- Expected: the ADVANCE arrival shows no overlay (its settle fires, not
  its arrival); the wheel ARRIVAL shows `#choice` without consuming the
  decision, and wheeling away closes it. The skip burst PAUSES at the
  decision with the overlay up — it does not sweep past — and the pick
  resumes MANUAL (no skip resume, no timer). Off the ending the
  re-opened decision carries the Return row (step 33's rule reached by
  the nav route), and Enter escapes the ending-loop onto `main-023`.
- RESULT (PASS, 2026-11-01): driver step 46: arrival press left
  #choice SHUT; wheel back onto `bridge-015` opened it with the exact
  prompt and 2 unmarked rows (showing consumes nothing), wheel-away
  closed it; tab paused the burst on the decision at +261 ms with the
  overlay held; the pick landed on `refuse-019` and 1500 ms moved
  nothing (manual); the re-offer rows were `[hire: null, refuse:
  "seen", "Return to main route" (continue)]` and Enter arrived on
  `main-023`.

### 44. Reset progress (Phase 16)

- Action: clean slate; walk to ~item 5 (intro-006) and press `b`; `c`
  -> the "Reset progress" row opens the confirmation box -> click
  Cancel, then reload; then open the box again and click Reset.
- Expected: the box asks ("Reset progress", Reset/Cancel) and nothing
  is cleared until confirmed — after Cancel the reload resumes on the
  SAME item with the bookmark row still stored and the help still
  closed; confirming runs the app's own delete+reload, which IS the
  first-ever play: help overlay up over a black stage, item 1 current,
  `t` says "No bookmarks yet — press b", and `c` reads the default
  1.00x with the switches off.
- RESULT (PASS, 2026-11-01): driver step 47: five presses landed on the
  intro-006 video and `b` pill-ed; the box opened with title/buttons
  exact; Cancel kept the resume item and the one stored bookmark across
  a reload; the confirmed Reset brought back the help screen on
  `meadow-001.jpg`, an empty `t` list with the empty notice, and
  `1.00x — ~60 ms/char` with skip/play both off.

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
- Skip with `skip_all` on mid-novel — the setting flipped while a skip
  is already running over partly-seen content: machine-tested, mid-skip
  setting changes included (`machine.test.ts`, `setSettings`), and step
  38 walks a full skip-through with it on from a clean slate (that
  consumes all unseen content, which is exactly why the other steps
  never run it before their resume points).
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
