# Navigation Performance (Phase 12)

The budget (docs/stack.md): navigation latency under 41 ms (1/24 s),
p95, measured not assumed. The harness is `player/scripts/perf.mjs`
(`npm run perf` from `player/`, after `npm run build`); it prints per-folder
JSON and writes `.tmp/perf-<name>.json`. `npm run perf -- DIR... [--start
ID]` walks other content folders (Navigation with sound). The preload lives in
`player/src/render/visual.ts` (+ its idle schedule in `app.ts`).

## What is measured

One cold first-read pass per folder in headless Chrome 156 over `file://`,
in a fresh storage context, driven by trusted CDP keypresses through the
real manual walk (each decision answered with its first unplayed route).
Phase 12's walk pressed twice per item, a settle press and an advance
press; since Phase 16 each Space moves one item, and the walk counts every
press since 2026-11-10 (Navigation with sound). In-page instrumentation
timestamps every trusted keydown and every rAF frame; a measured
navigation runs from the keypress the machine treated as a cursor move to
the first frame on which the NEW visual is decoded and paintable
(`img.complete` with a natural size; a video item's first paint is its
poster, probed through an `Image()`). The first two navigations are dropped as run-in. `text` items
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

## Saves at scale (Phase 46)

The player saves on every screen change. Until Phase 46 that save carried
the id of every item seen (`ctx.visited` in the state record), so on a
160,000-item game read to the end each Space rewrote about 4.5 MB: the
machine sorted the seen set, the codec mapped it to ids, and IndexedDB
cloned and wrote it. The seen set now has records of its own in the same
`state` store, at most 500 ids each, written only by the page that saw
them (`player/src/storage/idb.ts`); a save writes the reader's place and
the page's newest seen record, never the whole list.

`player/scripts/saveperf.mjs` (`npm run perf:save` from `player/`, after
`npm run build`; options `--player FILE`, `--engines`, `--seen`,
`--steps`, `--items`, `--out`) writes a synthetic game of 161,000 screens
to `.tmp/perf-save/`: three decisions at the start (the shape of
`mapperf.mjs`'s generator), then one main line of `text` lines with a
picture every 200, every id 28 characters (the real game's average is
28.5). For each engine and seen count it opens the game with `openGame`,
seeds a state record in the pre-Phase-46 layout (the first N ids seen,
the reader on the Nth), loads over it, presses Space once (untimed), and
times 100 Spaces: the press alone and the walk step (the press and a
`current()` read). The same seed is the migration path for the new
layout, so before and after start alike. Output: JSON on stdout and
`.tmp/perf-save.json`.

Space, p50 / p95 ms, 100 presses each, 2026-11-09 (shared machine, load
average 6-15):

| engine | seen | before: press | after: press | before: walk step | after: walk step |
| --- | --- | --- | --- | --- | --- |
| WebKit | 100 | 0.7 / 1.1 | 0.7 / 1.2 | 2.2 / 2.7 | 2.2 / 2.7 |
| WebKit | 160,000 | 6.9 / 42.9 | 0.8 / 1.8 | 9.4 / 46.2 | 2.6 / 5.1 |
| Chrome | 100 | 0.5 / 0.9 | 0.5 / 0.8 | 2.1 / 2.5 | 2.0 / 2.3 |
| Chrome | 160,000 | 9.0 / 11.0 | 0.5 / 0.8 | 12.0 / 12.7 | 2.1 / 2.9 |

"Before" is the player as of commit 6d35bf6, "after" this phase's
(`.tmp/perf-save-before.json` and `.tmp/perf-save.json`). At 160,000
seen the mean press fell from 16.5 to 1.1 ms on WebKit and from 8.2 to
0.6 ms on Chrome; at 100 seen nothing changed. Two earlier runs agreed:
WebKit at 160,000 seen 8.1-10.1 / 41.3-50.7 ms before, 0.9-1.3 /
2.3-4.6 ms after; Chrome 11.9-12.8 / 14.1-15.6 before, 0.7-1.0 /
1.5-1.7 after.

Loading costs about the same. The player is up (storage read, the reader
placed; the page's own clock from its navigation start) in 182 ms on
WebKit and 262 ms on Chrome at 160,000 seen after this phase, against 197
and 255 ms before (median of three reloads; most of it is the 12 MB
manifest). An old save moves to the new layout once, inside the load:
the load over the seeded 160,000-id record took 180 ms on WebKit and 252
ms on Chrome, against 146 and 221 ms for the same load before (one
sample each; an earlier run gave 272 against 168 and 355 against 277).
So the move costs about 30-100 ms, once. The first Space after it is an
ordinary save: 1.6 ms on WebKit, where the old player's first was 34.9
ms.

Before choosing the layout, a probe in both engines compared one record
per seen id with records of 500. Writing 160,000 one-id records took 5.7
s on WebKit and 9.4 s on Chrome, reading their keys back 257 and 405 ms,
and deleting them (Reset progress) 3.2 and 1.4 s; 320 records of 500
took 65 and 66 ms to write and 13 and 18 ms to read. Records of 500 it
is.

## Target sound (Phase 47)

`Machine.targetSound()` resolves the music and ambience for the screen on
show (docs/content-format.md, "What plays at an item"). The bound
(docs/plan.md Phase 47, item 4) is under 1 ms per arrival, p95, on a
synthetic story of 160,000 items, 400 decisions and 5,000 music changes.
`player/scripts/soundperf.mjs` (`npm run perf:sound` from `player/`)
bundles `src/machine/soundbench.ts` for Node, builds that story and times
every `targetSound()` call that follows an arrival. It prints JSON and
writes `.tmp/perf-sound.json`. `src/machine/soundperf.test.ts` checks the
same bound inside `npm test`.

The story has 100 top-level decisions, each nesting three more down its
first route, so 400 decisions four deep. They cycle through four shapes: a
continuing, a returning and an ending route; a continuing and a `continue`
route; a pure choice of two; a continuing and a returning route. Every
32nd item sets the music. Only item 0 sets ambience, so the ambience at
every later item resolves all the way back to the start, the longest walk.

The series:

- first call: the load's first `targetSound()`, which builds the per-item
  tables;
- reading: Space from item 0 to the end, play-all taking every route;
- jumps: 10,000 bookmark jumps (`goTo`) to random items after the reading;
- re-pick jumps: 10,000 branch-map route clicks at random decisions, each
  followed by a jump to a random item, both arrivals timed. Every click is
  a new last pick, which drops every kept answer, so most of these walk
  cold.

| series (2026-11-09) | arrivals | p50 ms | p95 ms | max ms |
| --- | --- | --- | --- | --- |
| first call | 1 | 17-23 | | |
| reading | 159,999 | 0.0001 | 0.0002 | 1.8-6.6 |
| jumps | 10,000 | 0.0005-0.0007 | 0.0011-0.0015 | 0.02-0.06 |
| re-pick jumps | 20,000 | 0.031-0.036 | 0.158-0.164 | 2.2-77 |

Three runs on an Apple M2 (8 cores, 16 GB), macOS 27.2, Node 24.13.1, at
load average 24-36 from other work on the machine.

Most of the path back is item i to item i - 1. Those stretches are static,
so machine/sound.ts precomputes, per item, the nearest setter inside its
stretch, and walks the path one stretch at a time. It asks the machine for
a step back (`stepBack`, the wheel's own step) only at a stretch's first
item, and keeps the answer there until a last pick changes, the seen set
is replaced, or an item at a stretch's edge is seen for the first time.
Reading on then costs one lookup. In one probe of the reading, 1,102
arrivals came right after such a drop and took 0.1-0.5 ms, and 1,453 took
10-100 us. A cold walk from the story's end takes 0.3-0.5 ms with the code
warm, 1.4 ms in a machine built moments before.

The maxima do not repeat. In one probe the two slowest re-pick arrivals
(16.6 and 2.4 ms) took 0.24-0.58 ms when timed again at the same
positions, and p99.9 over its 20,000 arrivals was 0.68 ms, so the spikes
are garbage collection or the loaded machine, not the walk. The first call
costs less than building the machine for this story (26-45 ms), once per
load, and a manifest whose items carry no audio never makes the tables.

## Navigation with sound (Phase 47)

docs/plan.md Phase 47 item 10: navigation p95 with sound playing, measured
as above, on fixtures/audio-demo and on item 4's synthetic story (Target
sound, above) written out as a game folder. The scripts changed for it:

- perf.mjs counted only every second Space as a cursor move, Phase 12's
  settle-and-advance walk. A picture reached by the other press paired
  with the press before it, 90 ms earlier, so the demo read p95 115.4 ms
  (2026-11-10, before the fix). Every Space now counts.
- `npm run perf -- DIR...` walks the content folders given, each
  assembled into `.tmp/perf-<name>`, and `--start ID` opens each at item
  ID through `#start=`.
- `npm run perf:sound -- --folder DIR` writes the story (160,000 items, 400
  decisions, 5,000 music changes, the ambience set at item 0) as a game
  folder instead of timing it. Item i shows `media/p<i mod 500>.jpg`,
  copies of one demo picture, so each of 500 items in a row loads a file
  not loaded before. The nine tracks are 2 s digitally silent mono WAV
  files, shipped since item 17 as an assembled folder ships them: each
  as its script alone (`media/<id>.wav.js`). The walk's 400 presses
  change the music about 12 times, each a 1 s crossfade.

The first run on that folder found a player fault. `mountAudio` spread
every item into `Math.max` to size its ambience elements, and Chrome threw
`RangeError: Maximum call stack size exceeded` on 160,000 arguments (it
took 120,000; WebKit took 160,000). A game that size showed its first
picture and answered no key. render/audio.ts `largestAmbienceSet` loops
instead.

The control is the same folder with every `audio` field removed. A probe
walked 120 items at the walk's pace with `openGame`, from item 0 and from
`i158793`, and read `current().audio`: the music crossfaded through four
or five tracks and the ambience played, unlocked by the first Space, as in
the walk.

With the HTMLAudioElement player of item 10 (Web Audio below):

| folder (2026-11-10) | n | p50 ms | p95 ms | max ms | p95 < 41 |
| --- | --- | --- | --- | --- | --- |
| fixtures/demo (no sound) | 14 | 24.1-25.8 | 33.0-36.3 | 33.0-36.3 | MET |
| fixtures/audio-demo | 21 | 25.0-27.7 | 33.2-35.0 | 33.8-37.9 | MET |
| sound story, from item 0 | 395 | 26.1-26.4 | 34.1-34.9 | 36.7-51.9 | MET |
| the control, from item 0 | 395 | 26.3-26.7 | 34.1-34.6 | 35.8-37.3 | MET |
| sound story, `--start i158793` | 397 | 26.2-27.1 | 33.8-34.7 | 36.7-40.6 | MET |
| the control, `--start i158793` | 397 | 25.9-26.3 | 34.2-34.9 | 35.6-51.7 | MET |

Three runs of each in headless Chrome 157 on an Apple M2 (8 cores, 16 GB),
macOS 27.2, at load average 1.9-4.7. `i158793` starts the last decision's
first route, four decisions deep near the story's end, where the
ambience resolves back across the whole story. perf.mjs drives Chrome only,
so WebKit was not measured.

Sound adds nothing measurable: the p95 ranges with and without audio
overlap, 34.1-34.9 against 34.1-34.6 ms from item 0 and 33.8-34.7 against
34.2-34.9 ms deep in the story. Two runs had one sample over 41 ms each,
51.9 ms with sound and 51.7 ms without.

The p50 sits near 25 ms where Phase 12's table shows 3.5-12 ms. The decode
preload (app.ts `schedulePreload`) runs only on a settled item or during a
skip, and Phase 12's settle press gave it a gap before each move. Now each
press arrives on an unsettled item, so most measured pictures decode cold.
This was not investigated further, since every p95 here is under 41 ms.

### With Web Audio (item 20)

The same walks on the Web Audio player (items 18, 19 and 22), whose
tracks load from their scripts and decode on the player's context in
Chrome. perf.mjs now also reads the decoded audio a walk leaves the
player holding (`player/scripts/perfaudio.mjs`, a test-only read in the
page: every buffer `decodeAudioData` resolves with, which in Chrome is
the buffer the player keeps, and a count of the buffer sources started).
It prints that as a second line, such as `audio: 15 files decoded at
48000 Hz, 15.8 MB (largest 2.3 MB), 15 sources started`, and as `audio`
in the JSON (null for a game without sound).

| folder (2026-11-13) | n | p50 ms | p95 ms | max ms | p95 < 41 | load average |
| --- | --- | --- | --- | --- | --- | --- |
| fixtures/demo (no sound) | 14 | 22.3-24.7 | 32.8-34.3 | 32.8-34.3 | MET | 3.5-5.4 |
| fixtures/audio-demo | 21 | 23.0-27.3 | 32.1-34.4 | 34.0-39.1 | MET | 3.5-5.4 |
| sound story, from item 0 | 395 | 25.8-26.9 | 33.5-34.7 | 36.3-96.8 | MET | 4.9-10.3 |
| the control, from item 0 | 395 | 25.6-26.6 | 33.0-34.2 | 34.4-42.8 | MET | 4.9-10.3 |
| sound story, `--start i158793` | 397 | 25.3-26.1 | 33.4-34.2 | 35.6-37.0 | MET | 7.3-12.2 |
| the control, `--start i158793` | 397 | 25.7-26.1 | 33.4-33.7 | 35.2-35.6 | MET | 7.3-12.2 |

Six runs of each demo and three of each story folder, in headless Chrome
157 on an Apple M2 (8 cores, 16 GB), macOS 27.2.1. The load average is
the 1-minute figure from other work on the machine, over each set of
runs. Sound still adds nothing measurable: from item 0 the p95 ranges
are 33.5-34.7 ms with sound and 33.0-34.2 ms without, and deep in the
story 33.4-34.2 against 33.4-33.7 ms. Two runs had one sample over 41
ms: 96.8 ms with sound at load average 8.9, and 42.8 ms without at 6.5.

Memory against the cap. Each audio demo walk decoded the demo's 15
tracks, 82.1 s of mono at the context's 48 kHz, to 15,763,520 bytes
(15.8 MB, 15.0 MiB), 7.5% of render/audiocache.ts `DECODED_CAP_BYTES`
(200 MiB); the largest is `steps`, 12 s, at 2.3 MB. The cache decodes
each file once and drops nothing while under its cap, so the player
held all of it at the walk's end. The sound story's nine tracks came to
3.5 MB. A 3-minute stereo AAC at 48 kHz (perf:decode's long track, in
place of the audio demo's calm tune) decoded to 69,120,000 bytes:
8,640,000 samples on each of 2 channels, 69.1 MB (65.9 MiB), a third
of the cap, and that walk's p95 was 34.2 ms (load average 4.4). So the
cap holds three such tracks, as audiocache.ts says, with room for the
short ones.

## Decode time (Phase 47)

docs/plan.md Phase 47, items 21 and 22. A track decodes whole before it
plays (render/audioload.ts). In WebKit, before item 22, a 3-minute stereo
AAC took about 3.2 s from the player's request to its buffer, so a jump to
a scene whose long track was not warmed up started it that late, and a
short sound asked for meanwhile waited behind it. Item 22 decodes each file
on an OfflineAudioContext of its own in WebKit, and an AAC whose rate is
the context's at twice that rate, keeping every second sample. Chrome,
Edge, WebView2 and Firefox decode as before.

`player/scripts/decodeperf.mjs` (`npm run perf:decode` from `player/`; it
bundles render/audioload.ts itself, so no build is needed) times this in
the WebKit driver and headless Chrome. It is a perf script rather than a
scenario part: it times a few hundred milliseconds, which four scenario
units side by side would blur, and it makes its media at run time with
PATH ffmpeg into `.tmp/perf-decode/` (kept for the next run, `--fresh`
makes them again), all synthetic pink noise and tones. It prints a summary,
writes `.tmp/perf-decode.json` and exits 1 when an engine fails:

- Same result: 20 s AAC files at 48 kHz and 44.1 kHz, mono and stereo,
  with an even and an odd number of samples, in M4A and ADTS, plus a FLAC.
  The player decodes each on a context at 48 kHz and at 44.1 kHz, and each
  is compared with `decodeAudioData` on an OfflineAudioContext at that rate.
  A decode at twice the rate must keep the length and first sample, align
  at lag 0, stay within 0.02 per sample, and keep the difference below
  15 kHz at least 60 dB under the signal there. Every other decode must
  match sample for sample.
- Timing: a 3-minute stereo AAC at 48 kHz and one at 44.1 kHz, each asked
  for alone, and a 10 s stereo AAC clip asked for 100 ms after the 48 kHz
  one. Each is timed from the request (the script tag) to the buffer,
  through the player's decode ("after") and through `decodeAudioData` on
  the player's context ("before"), on a fresh page each, in shuffled order,
  five rounds. WebKit passes when the median of each long track is within
  500 ms and the clip's within 100 ms. Chrome passes when no median after
  is slower than before by more than a factor of 1.25 plus 25 ms. The
  keeping of every second sample of 3 minutes of stereo, alone on the main
  thread, is reported too.

| case (2026-11-13), median ms over 5 rounds | WebKit before | WebKit after | Chrome before | Chrome after |
| --- | --- | --- | --- | --- |
| 3-minute stereo AAC, 48 kHz | 3165-3346 | 187-192 | 195-197 | 194-198 |
| 3-minute stereo AAC, 44.1 kHz | 131-134 | 131-134 | 323-332 | 320-327 |
| 10 s clip asked for 100 ms into the 48 kHz decode | 3129-3330 | 13-15 | 13 | 12-13 |
| the 48 kHz track under that clip | 3214-3416 | 180-189 | 196-197 | 197-212 |

Three runs on an Apple M2 (8 cores, 16 GB), macOS 27.2, the system WebKit
and headless Chrome 157, each with a context at 48 kHz, at load average
2.9-4.0. The slowest single round after item 22 was 246 ms for the 48 kHz
track and 16 ms for the clip in WebKit. The keeping took a median of
12-14 ms in WebKit (11-22 ms per round), where item 21's one-sample-a-step
loop took about 16 ms. The
44.1 kHz track does not take the new path on a 48 kHz context: it decodes
the usual way, now on its own context, which was already fast.

Run again for item 20 (2026-11-13, one run of five rounds, load average
7.1-8.0), both engines passing: in WebKit the 48 kHz track took 3,344 ms
before and 207 ms after, the 44.1 kHz track 137 ms after, and the clip
3,218 ms before and 14 ms after; in Chrome 212, 347 and 13 ms after. The
keeping took 12 ms in WebKit.

Same result in WebKit: the decodes at twice the rate kept every length,
first sample and alignment, and differed from the usual decode by 1.7e-3
to 7.9e-3 at most. Below 15 kHz the difference is 101 dB under the signal;
nearly all of it lies above 15 kHz, where the resampler at the higher rate
rolls off the top of the band. On the audio demo's calm tune (AAC, 48 kHz)
the tap read the mix within 8.9e-6 of the usual decode looped, through
three wraps (the `audio` scenario, which allows 1e-3). Every other WebKit
decode, and every Chrome decode, matched the usual decode exactly.

Rejected with data: decoding every AAC at twice the context's rate, not
only one at the context's own rate. A 48 kHz ADTS file on a 44.1 kHz
context then keeps 881,470 samples where the usual decode gives 881,471,
because WebKit's resampled lengths are not always exact multiples. A file
above the context's rate would also fold its band above half the context's
rate into the audible band, and at any other rate the usual decode is
already fast.

The decoded-audio cap (render/audiocache.ts `DECODED_CAP_BYTES`, 200 MiB,
three 3-minute stereo tracks) stays. A dropped track met again now costs
0.13-0.33 s rather than 3.2 s. That is still a late start on a walk back,
and the memory is what item 18 measured. While WebKit decodes at twice the
rate, it holds a buffer twice the kept one's size (138 MB for that track)
outside the cap, until the samples are kept.
