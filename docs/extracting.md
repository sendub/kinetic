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
of items, not whole games). This file records survey facts now; each
game's Results section is filled when its slice runs (follow-up items).

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

One subsection per sampled game, filled when its slice runs. All are
pending with reason: the slice runs in the follow-up item (`.rpy`-source
slices first, then the compiled-only and archive-only kinds once unrpyc
and the `.rpa` reader land).

### game-a.app

Pending: slice runs in the follow-up item.

### game-b.app

Pending: slice runs in the follow-up item.

### game-c patch (a1)

Pending: slice runs in the follow-up item.

### game-d.app

Done (2025-11-01, unrpyc item smoke). 12 `.rpyc` decompiled via the
vendored unrpyc (no `.rpy` present). `--max-items 8` yields 8 items
(5 image, 3 text), 0 media shipped: scene names are dynamic refs with no
`image` defs, so assets are unresolved. Skips logged are unrecognized
`play/stop sound|music` (925 total), unsupported statements (214), `menu`
(7), image-not-defined (5). Sources recorded in ledger `rpycSources`.

### game-e.app

Pending: slice runs in the follow-up item; needs the `.rpa` reader first
(scripts and assets are both inside archives).

### game-f.zip

Pending: slice runs in the follow-up item; unpacks to a scratch dir
first, then behaves like a loose `.rpy` project.
