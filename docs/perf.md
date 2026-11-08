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

## Bookmarks on the branch map (Phase 35)

`npm run perf:map` now also gives the synthetic game bookmarks (fourth
argument, default 180): one real `b`, then copies of its row on items
spread over the whole story, so on routes at every depth; half carry
their own captured 320x180 JPEG, half show the manifest still (shrunk
once). The open time now runs from the `m` keydown to the second frame
after the map has drawn its cards (`data-ready`: the bookmark list read,
the layout around the cards, the markup, the cards); a new phase pans at
100% with the cards at full size.

| case (2026-11-07) | first open | later opens | frames p95 (all phases) | frames > 33 ms |
| --- | --- | --- | --- | --- |
| 570 decisions, 90k items, 180 bookmarks | 57-67 ms | 55-66 ms | 16.7-16.8 ms | 0 of ~900 (one run in three: 2, while zooming) |
| 570 decisions, 90k items, no bookmarks (`30 6 26 0`) | 52 ms | 62-63 ms | 16.7-16.8 ms | 0 of ~900 |

Later opens now include the bookmark list read and the cards' DOM (the
layout is kept while the bookmarked screens and the view's shape stay),
so they no longer drop to ~20 ms. Every pan and zoom rewrites one CSS
transform on the stage that holds the SVG, the cards and the marker
(docs/plan.md Phase 35, "Rendering"); the cards restyle only when the
zoom changes. Layout on a real game of 87,361 items with 63 decisions
and 178 bookmarks takes 11.5 ms in node.

`scripts/bookmark-timing.mjs` (the Phase 29 Safari check) now times the
map: `m` to the map, to its cards, and each in-view card's picture.
Headless Chrome, `file://`, 64 seeded rows with captures: cards drawn
17 ms after the key, every in-view picture decoded by 35-69 ms on the
first open and 13-20 ms on reopens. Safari was not measured: as in
Phase 34, the safaridriver session never connects from this machine.

## Map lines at every zoom (Phase 40)

The tree's strokes keep their screen width (docs/plan.md Phase 40, map
lines): `--line-px` on the SVG's world group, in steps of 2^(1/8), so a
zoom restyles the lines and nodes only when it crosses a step (a stroke
within 4.5% of its width, exact at 100%). Pans restyle nothing, and
neither do zooms below 0.5, where the value is fixed. The counts and
pill numbers sit in a group beside the world, out of that restyle; the
decision figures stay in their nodes (their hover and focus colour).
`npm run perf:map` on the final build, eight runs (2026-11-08):

| build | opens | frames p95 (all phases) | frames > 33 ms |
| --- | --- | --- | --- |
| before (world-unit strokes), 3 runs | 54.6-67.4 ms | 16.7-16.8 ms | 0 of ~900 |
| `--line-px`, 8 runs | 51.1-68.9 ms | 16.7-16.8 ms | 0-3 of ~900 at 33.4 ms (two frames); one 283 ms frame in one run, not seen again |

Frame intervals are capped at the 60 Hz frame, so main-thread work per
wheel step was measured as well (CDP Performance metrics before and
after each of 360 wheel steps, three runs, the 570-decision tree at
1920x1080, about 1,700 SVG elements drawn). The first build set an
exact `--line-px` on the whole SVG every zoom frame:

| zoom range | build | mean | p99 | worst | steps that restyle |
| --- | --- | --- | --- | --- | --- |
| 0.65-1.0 | before | 1.5-1.7 ms | 3.9-10.2 ms | 4.4-25.3 ms | 0 |
| 0.65-1.0 | first | 5.6-5.8 ms | 11.4-14.5 ms | 34.0-35.6 ms | 306-323 of 360 |
| 0.65-1.0 | final | 2.1 ms | 4.7-5.3 ms | 6.8-22.5 ms | 60 of 360 |
| 1.0-1.54 | before | 1.5-1.7 ms | 3.2-4.3 ms | 3.7-21.9 ms | 0 |
| 1.0-1.54 | first | 5.9-6.4 ms | 11.4-18.3 ms | 12.3-55.9 ms | 305-326 of 360 |
| 1.0-1.54 | final | 2.1-2.2 ms | 5.7-6.1 ms | 7.1-18.8 ms | 60 of 360 |

A step that restyles costs 3.7-3.9 ms in the final build (6.1-7.1 ms in
the first). The worst step in every build is a culling redraw or a
garbage collection, as the 20-25 ms worst steps before the change show.

## One look at every zoom (Phase 41)

The map no longer swaps its pieces for plain rectangles below 0.6x (0.3x
for a small tree). Below that zoom the nodes are still drawn merged into
one path per look, with no element per node, but each path holds the
groups' own capsules (traced from the same start point, so dashes fall
the same) under the same classes and rules. The decision figures, pill
numbers and counts are drawn beside them (mapmodel.ts `mapDrawing`,
branchmap.ts `treeMarkup`). Culling now applies at every zoom. At the
same zoom, merged and grouped drawings differ only in edge anti-aliasing
(at most 56 of 255 on single edge pixels; the text is identical).

Counts and figures are left out where the tallest digits (9.4 px at
100%) would paint under one device pixel: below 0.106x at 1x, 0.053x at
2x. perf:map's tree with 180 bookmarks fits at 0.103x. There, drawing
them changes 0.12% of the pixels, by up to 84/255: specks under a pixel
tall, with no figure to read. They would also cost the cold first open
30-50 ms (87-112 ms measured), mostly first-time glyph rasterisation of
about 4,750 sub-pixel strings. Without bookmarks the tree fits at
0.196x, so its figures are drawn.

`npm run perf:map`, same machine, 2026-11-08:

| build | runs | first open | later opens | frames p95 (all phases) | frames > 33 ms |
| --- | --- | --- | --- | --- | --- |
| HEAD (Phase 40) | 6 | 52.0-60.6 ms | 51.1-64.4 ms | 16.7-16.8 ms | 0-1 of ~900 |
| Phase 41 | 9 | 52.3-83.2 ms (3 over 69: 69.3, 74.3, 83.2) | 53.6-67.1 ms | 16.7-16.8 ms | 1-5 of ~900 |
| HEAD, no bookmarks (`30 6 26 0`) | 2 | 54.1-54.2 ms | 55.9-62.7 ms | 16.7-16.8 ms | |
| Phase 41, no bookmarks (figures drawn at Fit) | 2 | 77.1-90.8 ms | 54.9-64.1 ms | 16.7-16.8 ms | |

The final build's three runs opened at 53.6-67.8 ms. Phase 41's first
opens average about 9 ms over HEAD's: Fit now draws the capsules and the
dashes. The extra slow frames come in the zoom phases, from the redraws
on crossing 0.106x and 0.6x.

Main-thread work per step was measured with CDP `Performance` metrics:
`TaskDuration` before each wheel step or drag move and after two
animation frames, on the 570-decision tree with 180 bookmarks at
1920x1080. These figures are higher than Phase 40's because each step
includes its frame's rendering, of which the 180 cards' per-zoom restyle
is about 5 ms.

| range | build | mean | worst |
| --- | --- | --- | --- |
| zoom 0.65-1.0, 360 steps, 3 runs | HEAD | 11.5-11.9 ms | 28.1-35.4 ms |
| zoom 0.65-1.0, 360 steps, 3 runs | Phase 41 | 11.1-11.7 ms | 29.0-37.1 ms |
| zoom 1.0-1.54, 360 steps, 3 runs | HEAD | 11.3-12.3 ms | 28.5-34.0 ms |
| zoom 1.0-1.54, 360 steps, 3 runs | Phase 41 | 11.3-12.1 ms | 22.2-34.0 ms |
| zoom Fit (0.103)-0.6, 360 steps | HEAD (3 runs) | 13.4-14.3 ms | 36.7-60.4 ms |
| zoom Fit (0.103)-0.6, 360 steps | Phase 41 | 17.6 ms | 70.7 ms |
| pan at Fit, 180 moves | HEAD (3 runs) | 5.5-6.1 ms | 11.0-36.4 ms |
| pan at Fit, 180 moves | Phase 41 | 5.4 ms | 10.0 ms |
| pan at 0.3x, 180 moves | HEAD (2 runs) | 5.7-5.9 ms | 10.2-16.5 ms |
| pan at 0.3x, 180 moves | Phase 41 | 8.2 ms | 36.0 ms |
| pan at 0.5x, 180 moves | HEAD (2 runs) | 6.0-7.1 ms | 11.6-22.3 ms |
| pan at 0.5x, 180 moves | Phase 41 | 5.7 ms | 13.6 ms |

The near range is unchanged, as is panning at Fit, where the figures
are left out. Between Fit and 0.6x the map now draws every count and
figure in view, so zooming there costs about 4 ms more per step on
average. Its worst steps are the redraws on crossing 0.106x and 0.6x.
Phase 41's next item replaces free zoom and pan with two views, so this
range is not tuned.

## Band layout (Phase 41)

Segment wrapping is gone. The map is laid out once as one strip
(mapmodel.ts `layOutStrip`: every position, where a cut may fall, and what
each band would hold) and then cut into bands of a width (`cutBands`).
Bands sit `wrapGap` (40) apart between what they draw: cards with their
3 px rings, the count under a stretch's first card, nodes, ticks, and the
"you are here" ring wherever it can sit (17 px round a stretch). Ten
cards on the demo's lead-in lose 54-70 px between one band's cards and
the next band's against the first cut of this layout, which reserved a
row's half height and the cards' room instead. Until the two views pass
the view's width, `bandWidthForAspect` picks the width for the view's
aspect. For each band count it tries the narrowest width that still
takes that many bands, and one roomier while the last band stays at
least half a band long, never under 1,280 px a band. In a 1920x1080
window perf:map's tree lays out as 4 bands with 180 bookmarks (15,843 x
9,031 world units, Fit 0.105x) and as 5 without (8,734 x 5,240, Fit
0.18x). Cut at 1,440 px, as Full size will cut it, it makes 53 and 30
bands, each within the width.

Node-side layout, each tree as an open builds it: the layout and then its
`layoutSignature`. Warm medians of 20 interleaved runs (10 for the larger
tree), 2026-11-08:

| tree | HEAD | band layout |
| --- | --- | --- |
| 570 decisions, 180 bookmarks | 17.4 ms | 17.8 ms |
| 570 decisions, no bookmarks | 16.3 ms | 16.0 ms |
| 2,340 decisions (`60 7 15`), no bookmarks | 131.7 ms | 130.3 ms |

Of the band layout, choosing the width takes 1-3 ms and the cut 2-5 ms
(8-13 ms on the larger tree). `layoutSignature` now hashes each number as
an integer rather than as a decimal string: 1 ms cold where it took 5.
That pays for most of the cut. A cold first call, as on a first open, is
still about 10 ms slower than HEAD's (median of 10 fresh processes: 38
against 28.5 ms for the layout, plus 1 against 5 ms for the signature).
That is the cut and the chooser running unoptimised.

`npm run perf:map`, HEAD and the band layout alternated run by run, so
each pair saw the same machine load (taken before the bands were packed
by what they draw, which moves Fit from 0.103x to 0.105x and leaves the
counts and figures out there as before):

| build (2026-11-08) | runs | first open | later opens | frames p95 (all phases) | frames > 33 ms |
| --- | --- | --- | --- | --- | --- |
| HEAD (segment rows) | 11 | 60.2-77.8 ms (median 66.2) | 52.0-64.1 ms | 16.7-16.8 ms; 33.3 in 2 of 55 phase runs | 0-5 of ~900 |
| band layout | 11 | 63.1-79.0 ms (median 73.5) | 50.6-68.5 ms | 16.7-16.8 ms; 33.3-33.4 in 5 of 55 phase runs | 0-10 of ~900 |
| HEAD, the 3 quietest pairs (load 8) | 3 | 66.2-70.7 ms | 52.0-62.5 ms | 16.7-16.8 ms; 33.3 in 1 of 15 | 0-2 of ~900 |
| band layout, the same 3 pairs | 3 | 69.5-78.1 ms | 52.7-68.5 ms | 16.7-16.8 ms; 33.4 in 1 of 15 | 0-10 of ~900 |

The machine was busy throughout this item, with Spotlight, media
analysis and log collection holding the load average between 8 and 200.
HEAD's own first opens here ran 60-78 ms (66-71 ms in the quietest
pairs), against 52-61 ms in the Phase 41 table above. First opens with
the band layout ran about 7 ms slower by median (73.5 against 66.2 ms):
the cold cut and chooser above. 9 of its 11 runs were over 69 ms, as
were 3 of HEAD's. Later opens keep the layout and match HEAD's.

## Two views (Phase 41)

Free zoom and pan are gone. The map has two views, Full size and Fit
(docs/plan.md Phase 41, "Two views"), and neither pans freely:

- Full size is scale 1, the strip cut at the map view's width less 24
  px a side (room for the "you are here" label at a band's end; mapmodel.ts
  `fullSizeWidth`), with no width chooser. It scrolls up and down by the
  stage's transform, as panning did, with a scroll bar the map draws, and
  culls as before.
- Fit chooses the band width and the scale together (`fitWidth`). For
  each band count it tries the narrowest width that takes that many, then
  four widths inside the best count's range and its neighbours'. The
  1,280 px floor of the interim chooser is gone: it only ever made Fit
  smaller (a third smaller for three cards on the demo in 1280x720). Fit
  does not move, so it draws the whole tree once, with no culling or
  redraws.

`fitWidth` takes 0.7-1.2 ms warm on perf:map's tree. At 1920x1080 it cuts
that tree into 4 bands at 0.105x with 180 bookmarks (counts and figures
left out, under a device pixel) and 4 bands at 0.189x without (figures
drawn). The fitted view's offsets are whole pixels.

A strip with cards on several rows over one span can leave no place to
cut within a narrow view: the tree with 180 bookmarks has an uncut span
of 947 px. There Full size draws below 1x, just enough to bring the
widest band inside the view (`fullSizeScale`), so nothing runs off the
sides. With 180 bookmarks that happens in map views under about 1,075 px
wide; the demo and the tree without bookmarks cut at any width from 600
px.

`npm run perf:map` now measures the first open (at Full size, laying the
strip out and cutting it), two more Full size opens, frame intervals
while Full size scrolls by the wheel and by a drag, the switch to Fit (F,
to the second frame after), two opens at Fit with its cut kept, and one
cold open at Fit after a reload. The machine was loaded throughout
(load average 4.4-8.4), so HEAD was run alternately with the new build,
2026-11-08:

| build | runs | first open | later opens | frames p95 |
| --- | --- | --- | --- | --- |
| HEAD (first open at Fit), load 4.4-4.9 | 4 | 69.1-84.1 ms | 52.3-65.5 ms | 16.7-16.8 ms |
| two views (first open at Full size), load 4.4-4.9 | 4 | 66.8-83.2 ms | 54.4-61.6 ms | 16.7-16.8 ms |
| HEAD, load 5.3-7.0 | 3 | 76.7-100.5 ms | 50.6-62.0 ms | 16.7-16.8 ms |
| two views, load 5.3-7.0 | 3 | 62.4-96.4 ms | 51.9-62.9 ms | 16.7-16.8 ms |

In every pair the Full size first open was at or below HEAD's first open
at Fit (medians 69.4 and 77.3 ms in the quieter four pairs).

The final build, 180 bookmarks and none (`30 6 26 0`), load average 7.6-8.4:

| tree | runs | first open (Full size) | later opens | switch to Fit | opens at Fit | cold open at Fit | scroll frames p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 180 bookmarks | 3 | 80.3-81.6 ms | 52.1-62.9 ms | 47.3-49.1 ms | 50.1-63.3 ms | 70.4-76.0 ms | 16.7-16.8 ms |
| no bookmarks | 3 | 55.4-68.5 ms | 61.4-64.1 ms | 96.6-118.1 ms | 60.6-70.7 ms | 90.2-112.7 ms | 16.7-16.8 ms |

Scrolling Full size keeps Phase 40's frame cost: p95 16.7-16.8 ms, at
most one frame over 33 ms in about 470. Opens at Fit with the cut kept
ran 50.1-63.3 ms with bookmarks and 60.6-70.7 ms without (one run of six
over 69 ms). The first open at
Full size with 180 bookmarks tracks HEAD's first open at Fit on the same
machine, both over 69 ms when the load is high. Earlier at load 4.4-4.9
the new build's first opens ran 66.8-83.2 ms.

Two cases are still over 69 ms: a cold open at Fit after a reload
(70-77 ms with bookmarks, 83-113 ms without) and the switch to Fit on
the tree without bookmarks (92-118 ms). That tree draws its counts and
figures at Fit, about 4,900 SVG texts. A trace of the switch shows about
7 ms in the F handler (width chosen, strip cut), 14 ms building and
parsing the markup, 22 ms of style and layout, 10 ms of paint and 32 ms
of GPU raster, mostly the texts' first rasterisation. HEAD's first open
at Fit on that tree ran 72-98 ms in the same alternated runs. A probe
that presses F right after the open, with no scrolling first, measured
the same switch at 43-49 ms; the gap to perf:map's figure was not
tracked down. In that probe `text-rendering: optimizeSpeed` on the map's
texts made no measurable difference (42-48 ms), so it was not kept.

A check run by the orchestrator on the final build (load average 7.4):
with 180 bookmarks, first open 69.4 ms, later opens 62.1-67.0, opens at
Fit 63.0-65.3, switch to Fit 48.2, cold open at Fit 69.5; without
bookmarks, first open 57.0, later opens 62.2-62.5, opens at Fit
56.5-65.7, switch to Fit 95.9, cold open at Fit 93.3; scroll frames p95
16.7-16.8 ms.

Accepted (user, 2026-11-08). docs/stack.md sets no budget for the map:
"within docs/perf.md's numbers" (about 52-69 ms) guarded against
regressions and was never a requirement. The two cases over it stay
under the roughly 100 ms within which a response to a key or click reads
as immediate, and they occur only on this synthetic tree, about nine
times the decisions of the largest real game measured (63). If a real
game's Fit is ever slow, draw Fit as a still picture: its figures on a
canvas, or one image kept until the layout changes.

## Even route spacing (Phase 42)

Route lines are now spaced by what lies between them (mapmodel.ts
`lineOffsets`), each line's height fixed once for the strip, and the
per-band row spreading (`rowOffset`) is gone. A tree without bookmarks
lays out exactly as before: perf:map's tree, `60 7 15`, the demo and
game I were checked position by position. With bookmarks the
map is shorter: perf:map's tree with 180 bookmarks at 1920 px went from
69,395 to 68,106 world units tall at Full size, and game I at
2,000 px from 11,505 to 9,340.

Node-side layout as a Full size open builds it (the strip, its
`stripSignature`, the cut at 1,920 px). These are warm medians of 20
interleaved runs (10 for the larger tree), 2026-11-08, load average 7.5:

| tree | HEAD (strip + signature, cut) | Phase 42 (strip + signature, cut) |
| --- | --- | --- |
| 570 decisions, 180 bookmarks | 14.7 + 2.0 ms | 16.5 + 1.3 ms |
| 570 decisions, no bookmarks | 14.2 + 1.3 ms | 15.4 + 1.0 ms |
| 2,340 decisions (`60 7 15`), no bookmarks | 123.5 + 5.3 ms | 129.7 + 4.6 ms |
| game I (63 decisions, 178 bookmarks) | 7.4 + 0.2 ms | 7.1 + 0.2 ms |

The spacing pass (a max tree over the lines' spans, read and raised once
per line piece) adds 1-6 ms to the strip, and the cut, with no rows to
spread, saves 0.3-0.7 ms. An earlier series at load 5 gave the same
picture with every figure higher (570 decisions with 180 bookmarks: 27.1
+ 3.1 against 26.8 + 2.5 ms).

`npm run perf:map` alternated with HEAD, 2026-11-08, load average
5.9-7.6:

| build | runs | first open | later opens | switch to Fit | opens at Fit | cold open at Fit | scroll frames p95 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HEAD | 3 | 69.1-84.3 ms | 53.0-61.9 ms | 47.4-49.3 ms | 57.1-61.7 ms | 69.7-76.7 ms | 16.7-16.8 ms |
| Phase 42 | 3 | 67.6-80.5 ms | 60.2-67.5 ms | 86.2-97.2 ms | 72.4-87.6 ms | 105.9-124.7 ms | 16.7-16.8 ms |

Three earlier runs of the final build (load 10.6-13.4) matched: first
open 57.6-80.6, later opens 52.2-64.2, switch to Fit 83.0-88.4, opens at
Fit 70.2-81.0, cold open at Fit 124.5-127.6 ms.

Full size is unchanged. Fit is slower because the shorter map fits
larger: 0.116x where HEAD's fitted at 0.105x. That is above the 0.106x
at which `figuresVisible` starts drawing the counts and figures on a 1x
screen, so Fit now draws 4,562 texts where HEAD drew 1. This is the cost
the tree without bookmarks already had at Fit in the table above
(switch 96.6-118.1 ms). The cold open at Fit, at 106-125 ms, is over
the roughly 100 ms the user accepted for that case.

Accepted (user, 2026-11-08), on the same grounds as Phase 41's: the tree
is synthetic, about nine times the largest real game. perf:map renders at
1x; on a 2x screen `figuresVisible` draws the figures down to 0.053x, so
this tree's Fit very likely drew them before Phase 42 too (not measured
at 2x). The still-picture fallback above stays the remedy if a real game's
Fit is ever slow.
