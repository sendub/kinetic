# Verify the Player Shell

Manual browser checklist for the player, per docs/plan.md Phase 5 item 4.
Covers the Phase 5 feature set: `file://` demo folder loading, image
visuals, text + speaker overlay, `h` toggle, space advance,
first-keypress fullscreen, and the empty-manifest state. Later phases
extend this file: Phase 6 replaces the animation and video placeholders
with real media, Phase 7 adds the wheel, Phase 8 `b`/`t`/`e`, and
Phase 9 `c`. The key map today holds only space and `h`, even though
skip and `e` already exist in the machine.

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
input. Exit code is 0 when every step is PASS or PARTIAL, 1 on any FAIL.

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

### 8. Animation item shows its labeled placeholder

- Action: advance to item 5 (spark-005).
- Expected: `#placeholder` shows "spark-005 — animation placeholder
  (media playback lands in Phase 6)"; no image element. Phase 6
  replaces this notice.
- RESULT (PASS, 2026-10-31): driver step 8: label text exact,
  `#visual-image` absent, item text in the overlay.

### 9. Video item shows its labeled placeholder

- Action: advance to item 6 (intro-006).
- Expected: `#placeholder` labels intro-006 as a video placeholder
  (Phase 6 pending); no image element.
- RESULT (PASS, 2026-10-31): driver step 9: label text exact, no image.

### 10. Text item keeps the earlier visual

- Action: advance to item 7 (line-007, a `text` item).
- Expected: per `machine.visualIndex()`, the visual is still intro-006's
  placeholder, byte-for-byte unchanged from step 9, while the overlay
  shows Mei and "The street glowed under the awning."
- RESULT (PASS, 2026-10-31): driver step 10: placeholder string
  identical to step 9's; speaker and line correct.

### 11. Empty folder shows the empty state

- Action: open `.tmp/verify-demo-empty/index.html` (dist stub manifest,
  no items).
- Expected: `#empty-state` reads "No content yet — this folder has an
  empty manifest."; no overlay; no errors.
- RESULT (PASS, 2026-10-31): driver step 11: notice text exact, overlay
  hidden, zero console output on that page.

### 12. Console stayed empty throughout

- Action: watch DevTools' console through the whole walk (both folders).
- Expected: zero console messages and zero uncaught errors; a plain
  `file://` open logs nothing, per the shell's own console contract.
- RESULT (PASS, 2026-10-31): driver step 12: zero console messages,
  zero page errors, both pages, whole run.

## Not covered yet

- Real media: animation frames and `<video>` arrive in Phase 6; steps 8
  and 9 will then assert frames, looping, and poster-to-play behavior.
- Wheel rewind: Phase 7. Bookmarks (`b`/`t`) and reload-resume: Phase 8.
  Config screen (`c`): Phase 9. Skip (`tab`) and unseen-jump (`e`) are
  machine-tested but not yet on the key map.
