# Verify the Player Shell

Manual browser checklist for the player, per docs/plan.md Phases 5-6.
Covers the Phase 5 feature set — `file://` demo folder loading, image
visuals, text + speaker overlay, `h` toggle, space advance,
first-keypress fullscreen, the empty-manifest state — and the Phase 6
media set: animation frame cycling with loop count, video poster-to-play
autoplay, the `text`-chain keeping one `<video>` element alive, and the
rewind still. Later phases extend this file again: Phase 7 adds the
wheel, Phase 8 `b`/`t`/`e`, and Phase 9 `c`. The key map today holds
only space and `h`, even though skip and `e` already exist in the
machine.

## Run it

From `player/`:

```sh
npm run build
node scripts/verify.mjs
```

The driver (`player/scripts/verify.mjs`, node + puppeteer-core) launches
headless Chrome, assembles `.tmp/verify-demo` from `fixtures/demo` plus
`dist/index.html` and `dist/app.js` (the fixture's `manifest.js` is never
overwritten), and `.tmp/verify-demo-empty` from the `dist` stub manifest,
then drives every step below and prints `PASS`, `PARTIAL`, or `FAIL` per
step. Keys go in as real CDP Input events (`Input.dispatchKeyEvent`), so
they are trusted and the fullscreen gesture logic sees them as user
input. Where a command is not on the key map yet (the wheel, until
Phase 7), the driver commands the machine directly through the
`__kineticDebug` seam that `render/app.ts` exposes; steps using it say
so and cap at PARTIAL. Exit code is 0 when every step is PASS or
PARTIAL, 1 on any FAIL.

To walk it by hand instead: run `node scripts/verify.mjs` once (or
assemble the folder yourself per CREATE.md § Playing the folder), open
`.tmp/verify-demo/index.html` in Chrome with DevTools' console open, and
press keys. One machine fact keeps the manual walk predictable: the
first space press on a freshly shown item completes it in place
(immediate-complete, machine Phase 3) and the next press moves on, so
advance two presses per item.

Results below were walked on 2026-10-31 by the driver on headless Chrome
156.0.8078.76, twice with identical output.

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
  overlay shows Mei and "The street glowed under the awning."
- RESULT (PASS, 2026-10-31): driver step 10: expando identity
  confirmed (`sameElement=true`), `loop=true`, `paused=false`, no
  placeholder, hidden image; speaker and line correct.

### 11. line-007 → line-008 does not touch the video element

- Action: advance to item 8 (line-008, another `text` item in the
  chain).
- Expected: the chain advance must not re-create or reload the visual:
  same `<video>` element identity (asserted via the stashed expando),
  still looping and playing; overlay shows the line, no speaker.
- RESULT (PASS, 2026-10-31): driver step 11: `sameElement=true`,
  `loop=true`, `paused=false`, `currentTime > 0`; overlay text exact,
  no speaker element.

### 12. `h` over a playing video

- Action: press `h` while line-008 shows over the looping video.
- Expected: `#overlay` becomes `[hidden]`; the video keeps playing on
  the same element, untouched.
- RESULT (PASS, 2026-10-31): driver step 12: `overlayHidden=true` while
  `sameElement=true`, `paused=false`; `h` again restores the overlay
  before the walk continues.

### 13. Rewind onto the video item shows the poster still

- Action: rewind two items back (line-008 → line-007 → intro-006
  itself; here below the frontier).
- Expected: the video shows its poster as a still — paused at
  `currentTime` 0, `loop` off, poster still painted — and is never
  re-created; media never plays on rewind.
- RESULT (PARTIAL, 2026-10-31): driver step 13: driven through
  `machine.wheelBack()` on the `__kineticDebug` seam because the wheel
  gesture itself is Phase 7 wiring — the renderer's still behavior is
  asserted, the wheel is not. Observed: `sameElement=true`,
  `paused=true`, `currentTime=0`, `loop=false`, poster background still
  set. Also inherently headless-imprecise: by format definition the
  poster IS the video's first frame, so poster-vs-frame pixels cannot
  be distinguished by observation; the paused-at-zero state and poster
  wiring are what this step can prove.

### 14. Empty folder shows the empty state

- Action: open `.tmp/verify-demo-empty/index.html` (dist stub manifest,
  no items).
- Expected: `#empty-state` reads "No content yet — this folder has an
  empty manifest."; no overlay; no errors.
- RESULT (PASS, 2026-10-31): driver step 14: notice text exact, overlay
  hidden, zero console output on that page.

### 15. Console stayed empty throughout

- Action: watch DevTools' console through the whole walk (both folders).
- Expected: zero console messages and zero uncaught errors; a plain
  `file://` open logs nothing, per the shell's own console contract. An
  autoplay rejection must be caught, never surfaced.
- RESULT (PASS, 2026-10-31): driver step 15: zero console messages,
  zero page errors, both pages, whole run.

## Not covered yet

- Wheel rewind GESTURE: the driver commands `machine.wheelBack()`
  through the debug seam (step 13); real wheel wiring lands in Phase 7.
  Bookmarks (`b`/`t`) and reload-resume: Phase 8. Config screen (`c`):
  Phase 9. Skip (`tab`) and unseen-jump (`e`) are machine-tested but not
  yet on the key map.
- The `ended`→`mediaEnded` advance gate for a STANDALONE video (no
  `text` after it): machine-tested; the demo fixture's only video is
  the head of a chain, so `ended` never fires there. A real-browser
  walk of an unplayable-video fallback (autoplay rejection → poster
  still → machine still advances) is likewise unit-covered only.
