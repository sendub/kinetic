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
Five slices have run; one of them ships media.

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

## Results

One subsection per sampled game; five slices ran (2026-10-31) and game-d
keeps its earlier smoke note. Every slice ran the same three commands:
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

One finding covers four of the five entries. A visual whose name has no
`image` definition keeps its item with a placeholder file name
(`clip 00686-001.png`) that the folder never ships, so the validator
fails it (`media file '…' does not exist in the folder`) and the browser
logs `ERR_FILE_NOT_FOUND` per item — no script errors, but nothing
paints. Dropping the item is not a free fix either: the validator wants
at least one item, so a game whose scenes are all dynamic names has no
valid folder until a scene name can be resolved against the loose files
and `.rpa` members the converter already reads. Two parser details cause
most of it, and they are reported here rather than patched (no converter
change went in with these runs):

- `image NAME = Movie(play="NAME.webm")` registers under the key
  `NAME = Movie(play`, because `_split_image_def` cuts the name at the
  first quote. The captured value is right, so those pixels are one key
  fix away. Probed locally: `{'clip 00686 = Movie(play':
  'clip 00686.webm'}`, while `image pose07 ="pose07.webp"` yields the
  clean key `pose07`.
- Say statements written `em"..."`, with no space after the speaker (the
  style in two of the five games), do not match `_SPEAKER_SAY_RE`, which
  requires whitespace, so they are reported as unrecognized statements and
  those slices carry no text items at all.

### game-a.app

Done (2026-10-31, slice item). `kinetic-extract
<corpus>/<category>/<status>/game-a.app
.tmp/slice-game A --files script.rpy --label play_track01 --max-items 6` →
exit 0: 6 items (image 6), 0 media shipped, resolution 1280x720 (default
— no source image could be measured). Validator exit 1 (6 placeholder
files missing). Play: 6 items walked, 0 decoded visuals, 0 overlay lines
(there are no text items), and the only console errors are the six
`ERR_FILE_NOT_FOUND`.

Nothing here was skipped for a reason the game could help; the slice was
kept because the flow and the names are real. Ledger for this run: 1854
unrecognized statements (a 6-item slice still parses the whole
`script.rpy` — the no-space dialogue style), 42 unsupported (`stop
music`, `play music "…"`), 9 `hide` skipped, 7 `image not defined`, 3
`menu unsupported`; every item note reads `no source asset resolved;
placeholder name`. Why only 0 media: the game's only 9 `image` defs are
the Movie lines above, so `scene clip 00686` finds no definition even
though `images/clip 00686.webm` exists in the loose `images/` dir
beside the `.jpg` stills — the spaces in the names are not the problem,
the name is simply never looked up.

Control run `--files screens.rpy --max-items 6` → exit 0, 0 items: the
player shows its empty state with a clean console, and the validator
rejects the empty `items` array. That is the "all scenes dynamic" case
recorded as a result rather than hidden.

### game-b.app

Done (2026-10-31, slice item). `kinetic-extract
<corpus>/<category>/<status>/game-b.app
.tmp/slice-game B --files sequence0.rpy --label start --max-items 6` →
exit 0: 6 items (image 6, two carrying their first dialogue line),
0 media shipped, resolution 1280x720 (default). Validator exit 1 (6
placeholder files). Play: 0 decoded visuals, 2 overlay lines painted, no
script errors beyond the six `ERR_FILE_NOT_FOUND`. Stale twins behaved as
designed: ledger `rpycIgnoredTwins` records `game/sequence0.rpyc` with
`game/sequence0.rpy` kept.

Ledger for this run: 33 `menu unsupported` (this game branches a lot),
22 unrecognized statements (`if cond == True:` and `else:` block heads),
7 `image not defined`, plus `jump` follow notes. Why 0 media: the game
has no `image` statement at all (0 across all 14 `.rpy` files), so
visuals are `show credits1 at top_middle` and `scene bg black` while the
files sit in the same folder as `images/credits1.png` and
`images/bg black.png` — the name is the file stem, and only a name-to-file
lookup would connect them. `show screen hud` was also taken as a
visual (`screen-hud-001`); a `show screen` should probably be reported
and skipped the way `show layer` is.

### game-c patch (a1)

Done (2026-10-31, slice item). The patch dir holds four `.rpy`/`.rpyc`
pairs and no `game/` directory,
so the slice ran from a scratch copy:
`cp -R "<corpus>/<category>/<status>/game-c/game-c/a1"
.tmp/c-src/game`, then `kinetic-extract .tmp/c-src .tmp/slice-game C
--files path_home1.rpy --label riding_home --max-items 6` → exit 0:
6 items (image 1, text 5 — the Russian dialogue uses `bram "..."` with
a space, so it parses), 0 media shipped. Validator exit 1 (1 placeholder
file). Play: 0 decoded visuals but all 6 overlay lines painted, and one
`ERR_FILE_NOT_FOUND` — the text side of the player works end to end on
this folder.

Ledger: 38 unrecognized statements, 16 unsupported, 9 `menu unsupported`,
`jump forest1` and `jump forest_a_chek` followed linearly, one
cross-file `call`. Why 0 media, two layers deep: the visual is
`scene walken1`, defined in the main `game C.app`, and that is the only
place assets live (`game C.app/Contents/Resources/autorun/game/images/
a1/forest/…`, listed); the converter resolves inside the input `game/`
directory only, so a patch overlay has nothing to ship. The patch's own
three defs are `image scene_c = Movie(play=
"/images/a1/forest/forest_b/scene_c.webm", pos=…, anchor=…)` — the
Movie-key gap again, on top of a project-rooted path no file in the patch
directory can satisfy.

One crash to note: pointing the CLI at a `game` directory reached through
a symlink dies in `parser.py:355`
(`twin.resolve().relative_to(project_root.resolve())` →
`ValueError: '…a1/path_home1.rpy' is not in the subpath of
'.tmp/c-src'`). A copied directory works, and the corpus was not
written to either way.

### game-d.app

Done (2025-11-01, unrpyc item smoke). 12 `.rpyc` decompiled via the
vendored unrpyc (no `.rpy` present). `--max-items 8` yields 8 items
(5 image, 3 text), 0 media shipped: scene names are dynamic refs with no
`image` defs, so assets are unresolved. Skips logged are unrecognized
`play/stop sound|music` (925 total), unsupported statements (214), `menu`
(7), image-not-defined (5). Sources recorded in ledger `rpycSources`.

### game-e.app

Done (2026-10-31, slice item). `kinetic-extract
<corpus>/game-e.app .tmp/slice-e --files
scripts/story_02.rpyc --max-items 6` → exit 0: 6 items (image 2, text 4),
0 media shipped. Validator exit 1 (2 placeholder files). Play: 0 decoded
visuals, all 6 overlay lines painted, no script errors beyond two
`ERR_FILE_NOT_FOUND`. The script came out of the archive (ledger
`rpaScriptSources`: `game/scripts.rpa!scripts/story_02.rpyc`), and
`--files` is what keeps a slice of this game small at all:
`script_entries` finds 1494 script members (55 top-level story and system
scripts plus the same set under eight `tl/` localisations), all `.rpyc`.

Ledger for the run: 67 unrecognized statements (mostly
`play music theme_loop if_changed …`), `call target 'center_text'` and
`'portrait'` cross-file notes, 2 `menu unsupported`, 2 `image not
defined`. Why 0 media — a real gap, not missing data: the scenes are
`scene streets owen 1` and `streets owen 2`, and listing `images.rpa`'s
index shows `images/EP2/streets owen 1.jpg`, which the archive fallback
can and does read out (`extract_cached`). What is missing is the binding:
no `image "streets owen 1"` definition exists in
`scripts/variables_anim_chars.rpyc` or its eight localised copies, so the
name is built at runtime and the archive lookup is never asked (it runs
only on a relative path a definition already produced).

### game-f.zip

Done (2026-10-31, slice item). Unpacked to scratch as the plan asks, and
only what the slice needs: 5 `game/*.rpy` members, then the 4 assets the
chosen segment names — 9 of 9332 entries. This is the slice that ships
media: `kinetic-extract .tmp/f-slice .tmp/slice-game F --files
script.rpy --label kinetic_slice_pose07 --max-items 4` → exit 0: 4 items
(image 4), 4 media shipped, resolution 1280x720 (most common source image
size). Validator exit 0. Play: 4 of 4 items painted (`naturalWidth`
1280), console clean, exit 0.

Three things this run pinned down.

- The file has 197 labels and all of them sit before line 2061: the story
  is one ~36 000-line `label start`, and the first visual with a
  definition is at line 3837. `--label` is the only way in, so the slice
  start was pinned by inserting `label kinetic_slice_pose07:` at that
  line in the scratch copy (nothing else edited, corpus untouched).
- The defs read `image pose07 = "pose07.webp"` while the files are
  `game/images/pose07.webp`. Unpacked faithfully the pass reports
  `source asset 'game/pose07.webp' not found yet` and ships 0 (that run
  is `.tmp/slice-game F-b`); with a copy where the def points — the shape
  Ren'Py's own recursive basename lookup produces — it ships 4. A
  subdirectory fallback would close this one too.
- All four shipped with `decision: preserve` and the note
  `jxl round-trip failed: kept original`: the lossless-JXL route declined
  these `.webp`, the originals went out as `.webp`, and Chromium decodes
  them at full size. No `.jxl` or MKV file reached the player in any of
  these five slices (this game's `.mkv` cutscene is a
  `renpy.movie_cutscene` python call, which the parser does not see).

A 6-item run from the same start also keeps `exit01` and `exit02`, which
have no definitions, and falls back to validator exit 1 with two
placeholder files; that ledger holds 15 096 unrecognized statements and
195 `hide skipped` — the no-space `mc"..."` dialogue style again.
