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

## Branch map (Phase 31)

`player/scripts/mapperf.mjs` (`npm run perf:map` from `player/`, after
`npm run build`; optional arguments `top depth run`) writes a synthetic
game to `.tmp/perf-map/` with the current bundle: 30 top-level decisions,
each with a continuing, a returning and an ending route, nesting to depth
6 (570 decisions, 1,710 routes) over 90,296 items, the size of the
largest real game (87,361 items). In headless Chrome at 1920x1080 it reads
120 screens, then measures the map's open time (the `m` keydown to the
second frame after the panel shows) and the frame intervals while it
zooms (wheel events at 60 Hz), pans by drag at a readable zoom and at the
fitted, labels-off zoom, and zooms back in, with Chrome's
long-animation-frame entries. Output: JSON on stdout and
`.tmp/perf-map.json`.

| case (2026-11-06) | first open | later opens | frames p95 (all phases) | frames > 33 ms |
| --- | --- | --- | --- | --- |
| 570 decisions, 90k items, one strip | 48-52 ms | 19-31 ms | 16.7 ms | 0-1 of ~720 |
| 2,340 decisions, 214k items (`60 7 15`), one strip | 71 ms | 27-30 ms | 16.7 ms | 0 of ~720 |
| 570 decisions, wrapped rows, endings tucked | 48-58 ms | 20-33 ms | 16.7-16.8 ms | 0-1 of ~720 (one run in five: 4) |
| 2,340 decisions, wrapped rows, endings tucked | 74-80 ms | 26-31 ms | 16.7-16.8 ms | 0 of ~720 |

The wrapped layout (docs/plan.md Phase 31, "Layout for a large game")
changes the fitted view, not the cost: at 1920x1080 the 570-decision
game wraps into 6 rows of 5 top-level segments (world 25,257 x 12,536,
aspect 2.0 for a 1920x956 view), fitting at scale 0.073 where the one
strip (150,057 x 2,136) fitted at 0.012; the 2,340-decision game wraps
into 7 rows and fits at 0.032 (was 0.005). Layout time in node is
unchanged within noise (12-19 ms and 119-141 ms against 13-33 ms and
125-129 ms before for the two games).

The first open includes the layout (about 30 ms at 570 decisions), which
is then kept. The first build drew every node as a group and every line
as one whole-tree path: later opens took 80-95 ms (mostly style and
layout of ~9,700 SVG elements), the fitted view panned at 50-80 ms
frames, and zooming in past 1.2x ran at 50-130 ms frames. Culling the
near nodes and drawing the far view as one path per look fixed the first
two; the last was the dashed strokes of the whole-tree line paths (their
dash count grows with zoom), fixed by culling the lines too.
