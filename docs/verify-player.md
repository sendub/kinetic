# Verify the Player Shell

Manual browser checklist for the player, per docs/plan.md Phases 5-7b.
Covers the Phase 5 feature set — `file://` demo folder loading, image
visuals, text + speaker overlay, `h` toggle, space advance,
first-keypress fullscreen, the empty-manifest state — the Phase 6 media
set: animation frame cycling with loop count, video poster-to-play
autoplay, the `text`-chain keeping one `<video>` element alive, and the
rewind still; the Phase 7 input set: wheel rewind and return with both
clamps, `tab` skip, `space` during skip, and `e`; and the Phase 7b
presentation rules: media fills the viewport as the largest centred
contain fit of its own aspect ratio, whatever screen it gets, and overlay
text says which mode it is — `data-mode="thought"` for an unspoken
thought, `"speech"` for dialogue — so CSS can draw the two differently
(thought italic, dialogue upright). Later
phases extend this file again: Phase 8 adds `b`/`t` and reload-resume,
Phase 9 `c`. The key map today holds space, `h`, `tab` and `e`; the wheel
has its own module (`render/wheel.ts`), because a wheel event is not a
key.

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
Every input is real CDP Input: `Input.dispatchKeyEvent` for keys and
`Input.dispatchMouseEvent` `mouseWheel` for the wheel. Both arrive
trusted, so the fullscreen gesture logic accepts them as user input and
the wheel takes the same path a trackpad takes: listener → accumulator →
machine → renderer. Nothing reads machine state from the driver — each
step asserts what the DOM shows. Step 21 is the exception on inputs: it
sets the viewport itself, the way rotating a phone does. Exit code is 0
when every step is PASS or PARTIAL, 1 on any FAIL.

To walk it by hand instead: run `node scripts/verify.mjs` once (or
assemble the folder yourself per CREATE.md § Playing the folder), open
`.tmp/verify-demo/index.html` in Chrome with DevTools' console open, and
press keys. One machine fact keeps the manual walk predictable: the
first space press on a freshly shown item completes it in place
(immediate-complete, machine Phase 3) and the next press moves on, so
advance two presses per item. For the wheel, one mouse notch is 100 px of
delta and steps exactly one item; steps are capped at ~12 per second, so
a fast flick cannot outrun the eye. For step 22, drag the window to a
shape that matches nothing — tall and narrow, or wide and short — and the
media should stay flush with one pair of edges, centred on the other
axis, with black only where the asset's aspect and the window's differ.
For step 19, the demo's two thought lines — line-008 over the looping
video, line-011 over the pier still — should read italic, and every other
line upright.

Results below were walked on 2026-10-31 by the driver on headless Chrome
156.0.8078.76, three times with the same statuses (23 steps: 21 pass, 2
honest partials; the evidence lines differ only in sampled video
`currentTime` and skip-dwell timings). The fit rule in step 22 is pinned
twice over: the pure `containFit` in `render/fit.ts` is unit-tested, and
the driver imports that same function as its expectation, so the two
cannot drift.

## Checklist

### 1. Demo folder loads

- Action: open `.tmp/verify-demo/index.html` in Chrome.
- Expected: the item-1 image (meadow-001.jpg) shows inside `#stage`;
  `#overlay` is visible with `#overlay-speaker` "Mei" and its line in
  `#overlay-text`; console is empty.
- RESULT (PASS, 2026-10-31): driver step 1: `#app` children are
  `[stage, overlay]`, image decoded and painted, speaker and text as
  expected.

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
  steps 10-13. The `ended`→`mediaEnded` gate is exercised by machine
  unit tests instead — a chain video loops and never fires `ended`, and
  the demo has no standalone video, so `ended` is not observable here.

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
  dwell 129 ms against the 120 ms setting; the frontier item
  `pier-009.jpg` appeared at +653 ms, decoded, with the overlay hidden
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

### 20. Reload resume

- Action: reload the page (⌘R) anywhere in the middle of content.
- Expected, once Phase 8 lands: the player comes back at the last seen
  item, the same spot `e` lands on.
- RESULT (PARTIAL, 2026-10-31): driver step 20: after reload the player
  showed meadow-001.jpg with Mei's first line — it restarted at item 0
  instead of resuming. Nothing persists the frontier yet: `main.ts`
  builds the machine with no `resumeFrontier`, and no storage exists.
  Persistence wired in Phase 8; this step is not faked.

### 21. Empty folder shows the empty state

- Action: open `.tmp/verify-demo-empty/index.html` (dist stub manifest,
  no items).
- Expected: `#empty-state` reads "No content yet — this folder has an
  empty manifest."; no overlay; no errors.
- RESULT (PASS, 2026-10-31): driver step 21: notice text exact, overlay
  hidden, zero console output on that page.

### 22. Media fills the screen with its own aspect ratio

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
- RESULT (PASS, 2026-10-31): driver step 22: at 700x1000 the 960x540
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

### 23. Console stayed empty throughout

- Action: watch DevTools' console through the whole walk (all folders).
- Expected: zero console messages and zero uncaught errors; a plain
  `file://` open logs nothing, per the shell's own console contract. An
  autoplay rejection must be caught, never surfaced.
- RESULT (PASS, 2026-10-31): driver step 23: zero console messages,
  zero page errors, every page, whole run — including the wheel events,
  the skip run, the reload and both geometry viewports.

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
- Bookmarks (`b`/`t`) and reload-resume: Phase 8, which also adds the
  storage interface the machine and shell read through. Config screen
  (`c`): Phase 9.
- Skip with `skip_all` on (skipping through unseen content, marking it
  seen, and ending at content end): machine-tested; the demo runs with
  the default `skip_all` off, and the setting arrives with Phase 9's
  config screen.
- A trackpad's small, rapid deltas: the driver sends one 100 px notch,
  which is a mouse wheel. The accumulator's threshold, rate cap and
  direction-flip rules are unit-tested (`render/wheel.test.ts`), not
  walked here; a human walk with a trackpad is a cheap extra.
- The `ended`→`mediaEnded` advance gate for a STANDALONE video (no
  `text` after it): machine-tested; the demo fixture's only video is
  the head of a chain, so `ended` never fires there. A real-browser
  walk of an unplayable-video fallback (autoplay rejection → poster
  still → machine still advances) is likewise unit-covered only.
