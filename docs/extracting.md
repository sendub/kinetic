# Extracting from the real corpus

Survey and per-game log for docs/plan.md Phase 11. The corpus lives at
`<corpus>`: the categories `<category>/` and `<category>/`
(with `complete/`, `ongoing`, `abandoned/`, `waiting for updates/`
subfolders), a `the studio's folder/` folder, and two `.app` bundles at the
top level. The volume is read-only and slow: targeted listings with
timeouts, never recursive greps, never any writes there.

Sampling rule: a few distinct packaging kinds (`.app` with `.rpy`
sources, loose project dir, compiled-only, `.zip` release), and once the
slice options exist, a few random slices per game (short contiguous runs
of items, not whole games). This file records the survey facts that
picked each slice, and the Results section holds what that slice ran.
Five slices have run; after the bug-fix re-run four of them ship media
and the fifth — a patch overlay whose assets live in another package —
extracts, validates and plays as an honest empty folder.

## Sampled games

| Game (path under the corpus root) | Kind | Script source | Asset archives | Notes |
| --- | --- | --- | --- | --- |
| `<category>/<status>/game-a.app` (`.app`, game at `Contents/Resources/autorun/game`) | `.app` + `.rpy` | `script.rpy` 204 KB (whole story, `label start` at line 125), plus `gui/options/screens/changenames.rpy` | none | Loose `images/` dir (1044 entries, names contain spaces and audio); scenes referenced by literal file stems (``scene clip 00001``) with no `image` defs; one `menu:` |
| `<category>/<status>/game-b.app` (same bundle layout) | `.app` + `.rpy` | `script.rpy` 17 KB + `sequence0-5.rpy` 111-246 KB (14 `.rpy`, each with stale `.rpyc`) | none | Loose `images/`, `gui/`, `audio/`; story split across sequence files (filename order matters) |
| `<category>/<status>/game-c/game-c/a1` | loose dir + `.rpy` | `capitalarr/pasts/road_a/path_home1.rpy` (small; `.rpyc` alongside) | none | A patch overlay: only script files, assets stay in the main `game C.app` game dir, so assets resolve only when run against it |
| `the studio's folder/game-d.app` (same bundle layout) | compiled-only (`.rpyc`) | 12 `.rpyc` (`script.rpyc` 332 KB, `02/03.rpyc` 313/629 KB) — no `.rpy` | none | Loose `images/`, `gui/`, `videos/`, `audio/`; needs vendored unrpyc, then parses like any source |
| `game-e.app` (top level, same bundle layout) | archive-only (`.rpa`) | no `.rpy`; `scripts.rpa` 46 MB holds the script sources; one 910 B patch `.rpyc` on disk | 6 `.rpa`: `images.rpa` 6.9 GB, `videos.rpa` 1.3 GB, `elite.rpa` 430 MB, `extras.rpa` 408 MB, `audio.rpa` 241 MB, `scripts.rpa` 46 MB | The hardest case: every asset and the scripts themselves need the `.rpa` reader before a slice is possible |
| `<category>/<status>/game-f.zip` | `.zip` release | inside the archive: `game/script.rpy` 1.6 MB (+ stale `.rpyc`) | none inside (2.8 GB, 9332 files, all loose) | Standard PC Ren'Py layout; per plan, unpack to a scratch dir before extracting |

Surveyed but not sampled: `<category>/<status>/an-electron-game.zip`
is an Electron build (`locales/*.pak`, no `.rpy` anywhere in the archive)
— not Ren'Py, excluded. `<category>/<status>/game-h/
game-h` is a loose project with 4 `.rpa` and no top-level
`.rpy`/`.rpyc` (scripts inside the archive, like game-e).
`<category>/<status>/game I/game I.app` has `.rpy`
sources, but its top-level ones are updater stubs; the story lives under
`scenes/` and `areas/` subdirectories, which the parser's `game/*.rpy`
glob does not see. `<category>/<status>/game-j.app` keeps scripts
in 5 `.rpa`. `<category>/<status>/a-16gb-release.rar` (16 GB)
was not unpacked.

Presence facts across the samples: no `.rpak` was found in any game
directory checked (four checked), so unrpak support stays conditional on
the corpus producing one; `.rpa` appears in game-e (6),
game-j (5), and game-h (4); `.rpyc`-only projects
(game-d) keep all assets loose on disk, while archive-only projects move
even the `.rpy` sources into `scripts.rpa`.

Statement census (cheap one-script scan, game-a `script.rpy`):
1013 `scene` + 1013 `with` transitions, speaker dialogue dominates
(`mc` 1169, `em` 431, `cam` 252), `pause` 71, `play`/`stop` audio 50/44,
9 `image` defs, 3 `menu:`. No exotic custom statements — the gap is
dynamic scene names that bypass `image` definitions, which the ledger
already reports as "image not defined".

## Slice support

The CLI gained `--label NAME` (start the walk at that label),
`--max-items N` (stop after N items), and `--files GLOB` (restrict the
parsed `.rpy` files). Smoke runs (2026-02-13):

- fixture: `kinetic-extract fixtures/renpy_demo .tmp/slice-demo --label
  inside --max-items 3` → exit 0, 3 items (image 2, text 1), valid
  manifest;
- corpus: `game-a.app` with `--files script.rpy --label start
  --max-items 5` → exit 0, 5 items (image 5, media shipped 0 — scene
  names are unresolved dynamic references; item slots and sources are
  recorded in the ledger).

## Output layout

Extracted media ships under `assets/<xx>/`, where `<xx>` is the first two
hex digits of the sha1 of that file's basename: the name, never the bytes
(docs/plan.md Phase 17). A bucket is therefore stable across runs whatever
the file holds, and one game's thousands of files spread over up to 256
shallow folders, because a single directory that large is what macOS
Finder stalls on. Names are unchanged (still id-based), so a bucket simply
holds many files, and a poster or animation frame is bucketed by its own
basename, not its source's.

Manifest `file`, `poster`, and `frames` values, and the ledger's
`shippedFile`, `shippedPoster`, and `dedupOf`, carry that relative subpath
(`assets/ef/bg-room-001.jxl`), legal since Phase 17.1 per
docs/content-format.md, and the player resolves it from the folder root.
`--flat` writes media into the folder root instead, for a small folder or
one whose contents you want to eyeball; a hand-authored folder such as
`fixtures/demo` stays flat either way.

## Results

One subsection per sampled game. The first pass ran five slices
(2026-10-31) and recorded five extractor bugs; the same five slices were
then re-extracted with the fixes in (same commands, same slice
parameters, output under `.tmp/slice2-*`) and their entries below carry
the new numbers, marked FIXED. game-d keeps its earlier smoke note (not
re-run). Every slice ran the same three commands:
the `kinetic-extract` line quoted per game,
`tools/validate_content.py <out>`, and
`node player/scripts/play-folder.mjs <out>` — a walk driver that copies
the built player bundle into the folder (the folder's own `manifest.js`
always wins), loads `index.html` over `file://`, reads the item count
from `window.KINETIC_MANIFEST`, presses space across the whole manifest
and reports which surfaces decoded (image `naturalWidth > 0`, a
`<video>`, or the notice), how many overlay lines it saw, and every
console or failed-request error. It exits 0 only when the console stayed
clean and each media file the manifest names has painted.

The first pass found that a visual whose name has no `image` definition
kept its item with a placeholder file name the folder never ships, so
the validator failed it and the browser logged `ERR_FILE_NOT_FOUND` per
item — while a folder that dropped all such items was invalid because
the schema demanded at least one item. All five recorded bugs are fixed
in the converter and the tools (with pytest coverage, and player
machine/render tests for the empty state):

- BUG 5 FIXED — implicit image registration, like Ren'Py's own
  (`kinetic_extract/images.py`): an index keys every image/video file
  under `game/` recursively by its path-without-extension and by its
  basename, and answers `.rpa` members the same way through
  `AssetArchives.candidates`; explicit `image` defs win over it. A
  scene/show name resolves exact key → path-with-directory key →
  basename key; an ambiguous basename takes the first candidate in
  sorted order and the item's ledger note says so. This is what binds
  game-a' and game-b's loose `images/` files (names
  with spaces included) and game-e's archive members. A
  patch overlay whose assets live in another package (the game C
  Chronicles entry) still answers nothing — cross-dir lookup is out of
  scope and recorded below as an honest empty.
- BUG 1 FIXED — an item whose visual resolves nowhere is dropped (the
  ledger reports `droppedUnresolved` per statement), never shipped as
  a missing-file placeholder; the lines under a dropped visual drop
  with it, because a `text` item needs a visual. The schema now accepts
  an empty `items` array (`minItems: 0`, docs/content-format.md), the
  player renders a clean no-content state for an empty manifest, and
  `play-folder.mjs` reports `items: 0` with `errors: []`.
- BUG 2 FIXED — `image X = Movie(play="file.webm")` registers under the
  clean key `X` (`_split_image_def` cuts the key at the `=`; the value
  keeps its parens and `def_value_target` reads the play file), and a
  scene referencing `X` yields a VIDEO item with that file, real
  `durationSeconds` via ffprobe, shipped video and poster.
- BUG 3 FIXED — the speaker regex accepts the no-space `em"..."` /
  `mc"..."` form; those lines are dialogue now, not "unrecognized
  statements".
- BUG 4 FIXED — a `game` dir reached through a symlink parses: ledger
  rels are computed against the `game` dir itself (the old
  `twin.resolve().relative_to(project_root.resolve())` at parser.py
  raised `ValueError` there), with `os.path.realpath` on both sides as
  the fallback. The game C run below re-ran through a corpus symlink
  with the same clean result.

### game-a.app

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/<category>/<status>/game-a.app
.tmp/slice2-a --files script.rpy --label play_track01 --max-items 6` →
exit 0: 6 items (video 6), 6 media shipped, resolution 1280x720
(default — the shipped surfaces are all videos, nothing measured as an
image). Validator exit 0. Play: all 6 video surfaces decoded, 0 overlay
lines (this stretch carries no dialogue), console clean, exit 0.

This entry now proves BUG 2 end to end: the six sliced scenes are
exactly `image NAME = Movie(play="NAME.webm")` definitions — the ids
come out clean (`clip 00686-001`, not `clip 00686 = Movie(play…`),
each item is a VIDEO item with the game's own
`images/clip 00686.webm` (spaces in the names are no problem), its
ffprobe duration, and a poster. Ledger for the run: 52 unrecognized
statements (down from 1854 — BUG 3 turns the `em"..."`/`mc"..."` lines
into dialogue), 42 unsupported (`stop music`, `play music "…"`), 9
`hide` skipped, 3 `menu unsupported`; no `image not defined` and no
`droppedUnresolved` entries remain — BUG 5's index answers the other
scene names from the loose `images/` dir.

Control run re-run: `--files screens.rpy --max-items 6` → exit 0, 0
items, validator exit 0 (the empty `items` array is valid), and
play-folder reports `items: 0` with `errors: []` — the "all scenes
dynamic" case is a clean empty pass now, the player showing its
no-content notice (BUG 1 + schema), not a validator failure.

### game-b.app

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/<category>/<status>/game-b.app
.tmp/slice2-b --files sequence0.rpy --label start --max-items 6` →
exit 0: 6 items (image 6, two carrying their first dialogue line), 4
media shipped (three `scene bg black` refs deduped onto one file),
resolution 1920x1080 (most common source image size — real pixels now,
not the default). Validator exit 0. Play: 4 of 4 distinct images
painted (`naturalWidth` 1920), 3 overlay lines, console clean, exit 0.

This is BUG 5's home turf: the game has no `image` statement at all,
and `show credits1`/`scene bg black` now resolve through the implicit
index to `images/credits1.png`/`images/bg black.png` — the name-is-the-
file-stem case is exactly the path-with-directory/basename key lookup,
and three of the six shipped as lossless JXL (smaller, verified).
Stale twins behaved as designed: ledger `rpycIgnoredTwins` records
`game/sequence0.rpyc` with `game/sequence0.rpy` kept. Ledger for the
run: 33 `menu unsupported` (this game branches a lot), 22 unrecognized
statements (`if cond == True:` and `else:` block heads), `jump` follow
notes. The first pass also turned `show screen hud` into a visual
(`screen-hud-001`); a `show screen` should still be reported and
skipped the way `show layer` is — an open follow-up, not re-run here.

### game-c patch (a1)

Done (2026-10-31, bug-fix re-run; supersedes the first pass). Same
scratch copy as the first pass (the patch dir holds four
`.rpy`/`.rpyc` pairs and no `game/` directory):
`cp -R "<corpus>/<category>/<status>/game-c/game-c/a1"
.tmp/c-src/game`, then `kinetic-extract .tmp/c-src .tmp/slice2-c
--files path_home1.rpy --label riding_home --max-items 6` → exit 0:
0 items, 0 media shipped. Validator exit 0. Play: `items: 0`,
`errors: []`, exit 0 — the player's no-content state, clean.

An honest empty, stated plainly: the patch's assets all live in the
main `game C.app` (its `game/images/a1/forest/…`), the converter
resolves inside the input `game/` directory only, so no visual in the
sliced flow answers anything and the ledger carries 409
`droppedUnresolved` notes. BUG 1 drops each such item, and its
dialogue lines with it — a `text` item needs a visual — so the first
pass's "6 overlay lines over one placeholder image" became this empty
folder rather than a validator failure; the patch's own three defs are
`image scene_c = Movie(play="/images/a1/forest/forest_b/
scene_c.webm", pos=…, anchor=…)` lines, which BUG 2 now registers
under clean keys, but their project-rooted play paths name no file the
patch directory contains. Cross-package (overlay → main game) asset
resolution would be new scope; it stays recorded here as the reason
this entry is empty, not playable content.

BUG 4 re-check, no copy needed any more: `ln -s "<corpus>/…/a1"
.tmp/c-link/game; kinetic-extract .tmp/c-link .tmp/slice2-c-link
--files path_home1.rpy --label riding_home --max-items 6` → exit 0,
same ledger shape. The old `parser.py` `ValueError` for a symlinked
`game` dir is gone; the corpus was not written to either way. Ledger
for the run otherwise as before: 38 unrecognized, 16 unsupported,
9 `menu unsupported`, `jump forest1`/`jump forest_a_chek` followed
linearly, one cross-file `call`.

### game-d.app

Done (2025-11-01, unrpyc item smoke). 12 `.rpyc` decompiled via the
vendored unrpyc (no `.rpy` present). `--max-items 8` yields 8 items
(5 image, 3 text), 0 media shipped: scene names are dynamic refs with no
`image` defs, so assets are unresolved. Skips logged are unrecognized
`play/stop sound|music` (925 total), unsupported statements (214), `menu`
(7), image-not-defined (5). Sources recorded in ledger `rpycSources`.

(2026-10-31: not re-run this round — its zero-media outcome is exactly
the BUG 1/5 pair now fixed, and the decompiled-script path with implicit
resolution against a loose `images/` dir is covered by the CLI test in
`converter/tests/test_rpyc.py` on the checked-in `credits.rpyc`.)

### game-e.app

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/game-e.app .tmp/slice2-e --files
scripts/story_02.rpyc --max-items 6` → exit 0: 6 items (image 2, text
4), 2 media shipped, resolution 1920x1080 (most common source image
size). Validator exit 0. Play: both images painted (`naturalWidth`
1920), all 6 overlay lines, console clean, exit 0.

The binding the first pass found missing is now made the way Ren'Py
makes it: `scene streets owen 1` has no `image` definition anywhere
(that stays true — the name is built at runtime), and BUG 5's index
answers it from `images.rpa`. The ledger assets read
`rpa!images/EP2/streets owen 1.jpg` / `… owen 2.jpg`, the members
extracted through the usual cache and shipped by the normal asset pass
with their `rpa` provenance notes. `--files` is still what keeps a
slice of this game small: `script_entries` finds 1494 script members,
all `.rpyc`, and the script came out of the archive (ledger
`rpaScriptSources`: `game/scripts.rpa!scripts/story_02.rpyc`). Ledger
for the run keeps its shape: 67 unrecognized statements (mostly
`play music theme_loop if_changed …`), the cross-file `call target
'center_text'`/`'portrait'` notes, 2 `menu unsupported`; no `image not
defined` left.

### game-f.zip

Done (2026-10-31, bug-fix re-run from the same scratch dir; supersedes
the first pass — the unpacking itself, 9 of 9332 entries, stands).
`kinetic-extract .tmp/f-slice .tmp/slice2-f --files script.rpy
--label kinetic_slice_pose07 --max-items 4` → exit 0: 4 items (image 2,
text 2), 2 media shipped, resolution 1280x720 (most common source image
size). Validator exit 0. Play: 2 of 2 images painted (`naturalWidth`
1280), all 4 overlay lines, console clean, exit 0.

The four items changed shape, not health: BUG 3 makes the `mc"..."`
lines dialogue, so the 4-item budget is two poses plus two dialogue
lines instead of four poses. Both still ship `decision: preserve` with
`jxl round-trip failed: kept original` — the lossless-JXL route
declines these `.webp`, the originals go out as `.webp`, Chromium
decodes them at full size. No `.jxl` or MKV file reaches the player
here either; this game's `.mkv` cutscene is a `renpy.movie_cutscene`
python call, which the parser does not see.

The unpacking finding from the first pass is now closed by BUG 5. The
defs read `image pose07 = "pose07.webp"` while a faithful unpack puts
the files at `game/images/pose07.webp`; re-running the faithful shape
(the copy-dir run `.tmp/slice2-f-faithful`) resolves the def's
missing file through the implicit basename key and ships 2 of them,
validator exit 0 — no def-pointing copy needed any more.

The 6-item run from the same start re-ran too
(`.tmp/slice2-f6`): exit 0, 6 items (image 2, text 4), 2 media,
validator exit 0, play 0 (both painted, 6 overlay lines). The
first pass's two definition-less `exit01`/`exit02` placeholder items
are dropped now (BUG 1), the 15 096 unrecognized statements were mostly
the no-space dialogue style and are gone (96 remain), the 195
`hide skipped` stand.

Two facts from the first pass still hold and cost no re-run: the file
has 197 labels all before line 2061 (the story is one ~36 000-line
`label start`, first defined visual at line 3837), so `--label` is the
only way in — the slice start was pinned by inserting
`label kinetic_slice_pose07:` at that line in the scratch copy, corpus
untouched.
