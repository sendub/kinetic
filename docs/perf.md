# Navigation Performance (Phase 12)

The budget (docs/stack.md): navigation latency under 41 ms (1/24 s),
p95, measured not assumed. The harness is `player/scripts/perf.mjs`
(`npm run perf` from `player/`, after `npm run build`); it prints per-folder
JSON and writes `.tmp/perf-<name>.json`. The preload lives in
`player/src/render/visual.ts` (+ its idle schedule in `app.ts`).

## What is measured

One cold first-read pass per folder in headless Chrome 156 over `file://`,
in a fresh storage context, driven by trusted CDP keypresses through the
real manual walk (settle-press, advance-press; each decision answered with
its first unplayed route). In-page instrumentation timestamps every
trusted keydown and every rAF frame; a measured navigation runs from the
keypress the machine treated as a cursor move to the first frame on which
the NEW visual is decoded and paintable (`img.complete` with a natural
size; a video item's first paint is its poster, probed through an
`Image()`). The first two navigations are dropped as run-in. `text` items
change no visual and animation frame-cycles inside one item are not
navigations, so the sample counts equal the visual-change navigations the
fixtures contain (demo 10, extract 8) — the "≈40 navigations" of the plan
is above what a 24-item and a 19-item folder hold. One sample is quantised
to the rAF frame boundary (~16.7 ms): the number states the frame the
picture could first paint on, no finer.

## Results

| build | folder | n | p50 ms | p95 ms | max ms | p95 < 41 |
| --- | --- | --- | --- | --- | --- | --- |
| no preload (baseline) | fixtures/demo | 10 | 27.9 | 36.7 | 36.7 | MET (marginal; an earlier run spiked max 61.8) |
| no preload (baseline) | .tmp/extract-demo (19 items, .jxl) | 8 | 13.9 | 32.2 | 32.2 | MET (marginal) |
| preload | fixtures/demo | 10 | 3.5–12 | 16–16.8 | 16–16.8 | MET |
| preload | .tmp/extract-demo (19 items, .jxl) | 8 | 2.6–8.6 | 10.2–18.6 | 10.2–18.6 | MET |

Without preload the fetch + decode of the entering file lands on the
navigation itself: cold navigations measured 2–4 frames (the p95 outliers
were `spark-005.f000.jpg` at 61.8/33.3 and the `.jxl` firsts at 32.2), and
a file this run had already painted navigated in ~0–1 frames — proof the
cost is the cold path, exactly what preloading removes. With preload every
navigation fits inside one frame's distance across two runs; the budget
has room and the docs/stack.md revisit trigger (bitmap counts, tiling,
WebGL) does not fire.

## Design probe and choice

Capability probe (run by the harness on `file://` images in this Chrome):
`img.decode()` present and ok; `createImageBitmap(<img>)` ok (960x540 and
320x180). So `createImageBitmap` works on `file://` — the chosen variant
simply does not need it:

- CHOSEN: hidden off-DOM `Image()` per upcoming file (fetch + decode
  through the SAME resource path the presenter's `<img>` uses on entry),
  held in an LRU `Map` capped at 8 files (eviction drops the reference;
  an `ImageBitmap` map would `close()` instead).
- Scope: the next 3 MEDIA items in array order (`upcomingVisualFiles`,
  pure + unit-tested); a `text` item adds nothing, an animation
  contributes all frames, a video contributes only its poster (first
  paint goes through the img decode path — the poster reuses the img
  warm path). v1 walks array order only, not route spans: an upcoming
  decision's routes are not trivially derivable before the reader
  answers, and the presenter still loads whatever it shows, so a wrong
  guess is a wasted warm, never a miss.
- Schedule: on idle (`requestIdleCallback`, timer fallback) when the
  machine state arrives settled or skip is dwelling — the idle moment
  between inputs; one queued task, reading the cursor when it runs.
- Rejected with data: swapping the `<img>` presenter for a canvas fed by
  pre-decoded `ImageBitmap`s would also remove the cold cost, but it is a
  full presenter refactor (fit, capture, chain rules re-derived) and the
  measured target is met without it. No fallback path was ever taken in
  headless Chrome (both probe APIs succeeded); the `Image()` design has
  no hard dependency on either API anyway.
