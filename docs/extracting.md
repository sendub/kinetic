# Extracting from the real corpus

Survey and per-game log for docs/plan.md Phase 11. The corpus lives
under the corpus root that AGENTS.md names: two category folders (each
with status subfolders such as complete, ongoing, abandoned and waiting
for updates), a studio's folder, and two `.app` bundles at the top
level. The volume is read-only and slow: targeted listings with
timeouts, never recursive greps, never any writes there. No game is
named here: the sampled games are game A to game F, and a path under the
corpus root reads `<corpus>/<game A>.app` or `<corpus>/…/<game A>.app`.

Sampling rule: a few distinct packaging kinds (`.app` with `.rpy`
sources, loose project dir, compiled-only, `.zip` release), and once the
slice options exist, a few random slices per game (short contiguous runs
of items, not whole games). This file records the survey facts that
picked each slice, and the Results section holds what that slice ran.
Five slices have run; after the bug-fix re-run four of them ship media
and the fifth — a patch overlay whose assets live in another package —
extracts, validates and plays as an honest empty folder.

## Sampled games

| Game (where under the corpus root) | Kind | Script source | Asset archives | Notes |
| --- | --- | --- | --- | --- |
| A: an `.app` in a category's status subfolder (game at `Contents/Resources/autorun/game`) | `.app` + `.rpy` | `script.rpy` 204 KB (whole story, `label start` at line 125), plus `gui`, `options`, `screens` and one more `.rpy` | none | Loose `images/` dir (1044 entries, names contain spaces and audio); scenes referenced by literal file stems (``scene beach 00001``) with no `image` defs; one `menu:` |
| B: an `.app` in a category's status subfolder (same bundle layout) | `.app` + `.rpy` | `script.rpy` 17 KB + six numbered story files (`<part>0-5.rpy`) 111-246 KB (14 `.rpy`, each with stale `.rpyc`) | none | Loose `images/`, `gui/`, `audio/`; story split across the numbered files (filename order matters) |
| C: a patch folder (`a1`) beside a game's main `.app` in a status subfolder | loose dir + `.rpy` | one small `.rpy` three folders down (`.rpyc` alongside) | none | A patch overlay: only script files, assets stay in the main `.app` game dir, so assets resolve only when run against it |
| D: an `.app` in the studio's folder (same bundle layout) | compiled-only (`.rpyc`) | 12 `.rpyc` (`script.rpyc` 332 KB, `02/03.rpyc` 313/629 KB) — no `.rpy` | none | Loose `images/`, `gui/`, `videos/`, `audio/`; needs vendored unrpyc, then parses like any source |
| E: an `.app` at the top level (same bundle layout) | archive-only (`.rpa`) | no `.rpy`; `scripts.rpa` 46 MB holds the script sources; one 910 B patch `.rpyc` on disk | 6 `.rpa`: `images.rpa` 6.9 GB, `videos.rpa` 1.3 GB, two more of 430 MB and 408 MB, `audio.rpa` 241 MB, `scripts.rpa` 46 MB | The hardest case: every asset and the scripts themselves need the `.rpa` reader before a slice is possible |
| F: a `.zip` in a category's status subfolder | `.zip` release | inside the archive: `game/script.rpy` 1.6 MB (+ stale `.rpyc`) | none inside (2.8 GB, 9332 files, all loose) | Standard PC Ren'Py layout; per plan, unpack to a scratch dir before extracting |

Surveyed but not sampled: one `.zip` is an Electron build
(`locales/*.pak`, no `.rpy` anywhere in the archive) — not Ren'Py,
excluded. Game H is a loose project with 4 `.rpa` and no top-level
`.rpy`/`.rpyc` (scripts inside the archive, like game E). One episode's
`.app` of a game released in episodes (game I) has `.rpy` sources, but
its top-level ones are updater stubs; the story lives in two
subdirectories of `game/`, which the parser's `game/*.rpy` glob does not
see. Game J, an `.app`, keeps scripts in 5 `.rpa`. A 16 GB `.rar`
release was not unpacked.

Presence facts across the samples: no `.rpak` was found in any game
directory checked (four checked), so unrpak support stays conditional on
the corpus producing one; `.rpa` appears in game E (6), game J (5), and
game H (4); `.rpyc`-only projects (game D) keep all assets loose on
disk, while archive-only projects move even the `.rpy` sources into
`scripts.rpa`.

Statement census (cheap one-script scan, game A's `script.rpy`):
1013 `scene` + 1013 `with` transitions, speaker dialogue dominates
(the top three speakers have 1169, 431 and 252 lines), `pause` 71,
`play`/`stop` audio 50/44, 9 `image` defs, 3 `menu:`. No exotic custom statements — the gap is
dynamic scene names that bypass `image` definitions, which the ledger
already reports as "image not defined".

## Slice support

The CLI gained `--label NAME` (start the walk at that label, then
follow the story from there: The walk follows labels, below),
`--max-items N` (stop after N items), and `--files GLOB` (restrict the
walked scripts: Which scripts are walked, below). Smoke runs
(2026-02-13):

- fixture: `kinetic-extract fixtures/renpy_demo .tmp/slice-demo --label
  inside --max-items 3` → exit 0, 3 items (image 2, text 1), valid
  manifest;
- corpus: game A with `--files script.rpy --label start --max-items 5`
  → exit 0, 5 items (image 5, media shipped 0 — scene
  names are unresolved dynamic references; item slots and sources are
  recorded in the ledger).

### Which scripts are walked

One function decides it, `walked_scripts` in
`converter/kinetic_extract/parser.py`, and both the story walk and the
translation identifiers (Translations, below) use it, so a script the
walk does not read neither hides another nor feeds identifiers
(docs/plan.md Phase 56 item 9d):

- **In scope**: every loose `.rpy` and `.rpyc` file under `game/`, at
  any depth, and every `.rpy` and `.rpyc` member of the `game/*.rpa`
  archives, at any depth, as Ren'Py loads every script under `game/`
  (docs/plan.md Phase 57 item 4b). `tl/` is never in scope: its scripts
  are translations (Translations, below), never story flow. A file or
  folder whose name starts with `.` is not either, as Ren'Py's loader
  (`walkdir` in `renpy/loader.py`) skips it. Before item 4b only the top
  level of `game/` and the loose files `--files` reached were in scope.
- **One source per path**: a loose file in scope beats an archive member
  with the same key, an earlier archive (in name order) beats a later
  one, and a `.rpy`, loose or archived, beats the `.rpyc` with the same
  path, which may be stale. The ledger lists what lost: `rpycIgnoredTwins`
  for a loose `.rpyc`, `rpaIgnoredTwins` for a member, with the reason.
- **`--files GLOB` chooses** among those: a `.rpy` whose path matches
  GLOB, and a `.rpyc` whose path matches GLOB with a final `.rpy` read
  as `.rpyc`, so `--files "*.rpy"` and `--files script.rpy` also take a
  compiled script that has no `.rpy`. A pattern ending in `.rpyc`
  chooses only compiled scripts, and one with no script extension
  (`cred*`) chooses both kinds. Loose files match as a glob from
  `game/` (`*` stays in one folder, `**` crosses folders); archive
  members match on their key or on their file name (`*` crosses
  folders), so `--files "*.rpy"` takes every archived script but only
  the top-level loose ones, and `--files "**/*.rpy"` takes the same set
  as no `--files` at all. A loose script `--files` leaves out still
  beats an archive member with its key, which is then not walked
  either. The `.rpy` that beats a chosen `.rpyc` is looked for whatever
  `--files` says.

The chosen scripts are parsed in file-name order (loose `.rpy`, loose
`.rpyc`, then archive members, sorted by file name with ties in that
order). Every one of them is read for definitions (`image`, `define`,
Characters, `define audio`, channels, screens), whether or not the story
reaches it; the story itself is read as the next section says.

### The walk follows labels

Ren'Py runs a game from `label start`, and so does the walk
(`kinetic_extract/flow.py`, docs/plan.md Phase 57 item 4e). Before it
the walk joined the scripts in file-name order, so lines in scripts the
story never runs (a developer script, a minigame) became items, and a
game whose story order differs from its file order read out of order.

- **Order**: from `label start` (or `--label NAME`) on through the
  statements of its file; past the end of a label's block into whatever
  follows in the same file (fall-through); to a `jump`'s label, wherever
  it is defined; into a `call`'s label and back to the statement after
  the call at its `return` or at the end of a file. `call x(args) from
  y` calls `x`. Local labels (`label .x`, `label g.x`) and named menus
  (`menu name:`) are labels too, as are literal `$ renpy.jump("x")` and
  `$ renpy.call("x")`. The end of a file returning is a deliberate
  difference: in Ren'Py, falling off the end of a file inside a call
  ends the game, while the walk keeps the content after the call.
- **Each statement once**: a label reached a second time is not walked
  again. A jump to it ends that path there (a loop back, or a scene two
  paths share, is read once, as the converter's routes rejoin the line
  they left); a call to it goes on after the call. The ledger counts
  both.
- **Forks**: an `if`/`elif`/`else` chain, a `while`, and a menu that
  does not become a decision keep their blocks skipped, as before, but
  the jumps and calls inside are followed: each block's in turn, up to
  the statement every block reaches (the fork's immediate
  post-dominator in the script's flow), then that statement once. So
  alternatives that rejoin read one after another and then the shared
  rest, as the file-order join usually read them; an `if` with no
  `else`, and a `while`, also go on past the fork. A label inside such a
  block is a place a jump can land. A menu that becomes a decision is
  read as the next item says.
- **Menus** (docs/plan.md Phase 60 item 4): a menu of two or more plain
  quoted choices becomes a decision (Branches, in
  docs/content-format.md). Each choice block is read as label flow: its
  lines, audio and nested menus, its `$` lines (assignments are kept on
  the menu's record for conditions; they change nothing here) and the
  `jump`, `call` or `return` it ends in. The walk reads each choice's
  path in turn up to where the choices meet, then that join once, as for
  any fork; the join is the post-dominator of the choices that do not
  loop back to the menu, read past each choice's own block, or, when one
  choice ends the story, where the others meet. What a choice's path
  reads is its route, and its `result` is how the path ended: at the
  join `"continue"`, back at the menu (its label, a named menu, a
  label that reaches it with no line between, or content already read
  from which straight-line code reaches it: the question before a
  refusal, re-read but not laid out again) `"return"`, at the story's
  end `"ending"`. The last choice reaching the join is the
  `continuingRoute`, and the join's first item the `continueAt`; a menu
  nested in a route whose choices meet where the enclosing menu's do
  takes the enclosing `continueAt`, past its route's end. A menu whose
  choices all fall through meets right after the menu, so it continues
  there too; one with no item after its join (the story's end, or a
  second menu straight after it) is a pure choice, its routes
  `"ending"`, and that second menu stays linear. A choice with nothing
  of its own (it goes straight to the join) is one line, its choice
  text, translated from the language's `strings` block. A route may
  hold any item (Phase 60 item 8b): pictures, ATL animations, videos
  and lines. A `text` item shows the nearest earlier media item in the
  item array, so when a route after the first starts with a line said
  over the visual on screen at the menu and an earlier route showed
  another, that line's item repeats the menu's visual: the same
  picture, the animation played again, the video from its start (with
  its own sound), or the last frame of an animation that holds it,
  with no transition; its ledger note says `repeats the visual on
  screen at the menu`. The ledger's
  `branchDetection` note for a decision gives each route's result and
  how the walk proved it (`reaches the join at game/script.rpy:58`,
  `jumps back to the menu`, `jumps back to the menu through its
  lead-in at game/script.rpy:40`, `reaches the story's end`), and its
  `continuingRoute` and `continueAt` or that it is a pure choice. A
  `return` in a choice is read as the story's end, even in a label
  reached by `call`. Linear and reported (`menu unsupported (...)`,
  `skipped` in `branchDetection`): a menu every choice of which is
  empty, one where a choice's path rejoins content read somewhere other
  than the join or the menu (a jump back to a label whose way to the
  menu, after a line, passes an `if` with a jump, another menu, a call
  or another jump is such a rejoin), a conditional choice (`"x" if cond:`), a
  `label` inside a choice block, and any line between choices other
  than a caption. Such a menu's blocks are skipped as for an `if`, their
  jumps and calls followed.
- **Screens**: `show screen x` and `call screen x` are a fork of the
  screen's literal `Jump("label")` and `Call("label")` actions, and
  those of the screens it `use`s, in the screen's order, and of going
  on past it, so a hub whose buttons jump reads each place they lead.
- **Computed targets**: `jump expression`, `call expression` and `$
  renpy.jump(var)`/`renpy.call(var)` name their label when the game
  runs, often from a list or table in Python (a scene picked by a
  function, an event system). The candidates are the labels named by a
  string literal anywhere in the game's code (Python blocks, `$` lines,
  `define` and `default` values, screen code, lists and dicts; not
  dialogue, menu choices or f-strings), leaving out the labels literal
  flow reaches anyway (found by a first walk that follows no computed
  target) and Ren'Py's entry labels (below). They are shared out among
  the sites (docs/plan.md Phase 57 item 4f), each label to:
  - the sites tied to it: a site whose own expression names it, or whose
    variable is set by Python that names it, followed through
    assignments in the site's own label or outside every label (init
    and python blocks, `define`, `default`, a screen's `SetVariable`),
    the functions that Python calls (`$ next_label = pick_scene(2)`,
    where `def pick_scene` names the scenes) and the variables those
    read, a few steps deep;
  - else the nearest site, by line, in the label's own file;
  - else, as does a label whose sites the walk never reaches, the first
    site the walk reaches.

  A site tries the labels its own expression names first (written
  order, even ones literal flow reaches), then its share, then the
  labels nobody owns, each group in file order, and walks those not
  walked yet: a `call expression` calls each in turn, returning to the
  site after each, and goes on; a `jump expression` reads each as a path
  of its own, one after another (a fork whose paths share no join), and
  its own path ends after them, as a jump's does. Each site is reported
  with how many candidates it had and walked; one with none is reported
  as not followed.
- **Not followed, and reported**: a target no walked script defines as
  a label, a computed target with no candidate, and anything Python
  decides without naming the label in a literal.
- **Ren'Py's entry labels** (`splashscreen`, `before_main_menu`,
  `main_menu`, `after_load`, `after_warp`, `quit`, `hide_windows`, and
  labels starting with `_`) are run by Ren'Py itself, not by the story:
  they are not walked and are never pool candidates. The summary names
  the ones the game has (`walk: Ren'Py entry labels not walked: ...`),
  so an agent can add one with `--also-label`.
- **More after the story**: `--also-label NAME` (repeatable) walks the
  story from that label after the story, as from `label start`;
  `--include-unreached` then appends every label still unreached that
  holds dialogue, in file order, each walked the same way. Both are
  recorded in the ledger's `slice` and `walk`. `--also-label` works with
  one project only, like `--label`.
- **No `label start`**: a project without one (a patch, a fragment) is
  read in file-name order as before, and the summary says so.

What the walk left out is listed, not emitted. The summary prints
`walk:` lines (labels reached and unreached, with up to 20 names, lines
of dialogue unreached; scripts unreached, rejoins, calls not repeated,
jumps and calls not followed; computed jumps and calls and the
candidates they walked; what `--also-label` and `--include-unreached`
added; the entry labels not walked), and the ledger's `walk` holds:

- `start`: `label start` or `--label NAME`;
- `labelsReached` (a count) and `labelsUnreached`: each label never
  reached, `{"label", "source", "lines"}` with the lines of dialogue in
  its block;
- `scriptsUnreached`: scripts with story statements or labels the walk
  never entered;
- `linesUnreached`: every line of dialogue not walked;
- `reportsUnreached`: how many reports the parser made for statements
  in unreached labels, which are left out of `report` (a menu there is
  `skipped` in `branchDetection` as "not reached from label start");
- `rejoins`, `callsNotRepeated` (`{"source", "statement"}` each) and
  `notFollowed` (`{"source", "statement", "reason"}`, also in `report`);
- `dynamic`: each computed jump or call reached, `{"source",
  "statement", "candidates", "own", "walked"}`, `own` the candidates its
  expression names or its share holds, `candidates` those plus the
  labels nobody owns (also in `report`);
- `entryLabelsUnreached`: the entry labels the game has that were not
  walked;
- `alsoLabels` (the `--also-label` names) and `appendedUnreached` (the
  labels `--include-unreached` appended, `{"label", "source",
  "lines"}`).

With several projects `walk` is a list, one object per project with
its `project` number, each walked from its own `label start`. A
file-order walk records `{"order": "file names (no label start)"}`.

## Several episodes, one game

A game released as several Ren'Py projects (episodes) becomes one
Kinetic game (docs/plan.md Phase 25): list the projects in story order,
then the output folder.

```sh
.venv/bin/kinetic-extract <episode1> <episode2> [...] <out> \
    [--decoder MODULE:FUNC ...] [--story-id ID] [--title TEXT] \
    [--game-version TEXT]
```

- One continuous story: each project is parsed and walked on its own,
  and episode 2's items follow episode 1's in one manifest. Each
  episode's decisions stay within it.
- Ids: every item, decision and route reference from project N gets
  the prefix `epN-` (`ep2-bg-room-008`, `ep2-menu-start-37`), so ids
  are unique and the same on every re-run with the same order. Saved
  progress is keyed by item id, so keep the order (adding an episode at
  the end changes no earlier id). An id that would pass 64 characters
  loses characters from its name part, never from its trailing number.
  A single project gets no prefix: its output is exactly as before.
- One `media/` folder: identical media across episodes is one file (one
  ledger `media` entry, the later episodes' sources under `alsoFrom`).
- `storyId`, `title` and `version` come from the first project unless
  `--story-id`/`--title`/`--game-version` are given; the summary notes when the projects
  derive different story ids. The display size is the most common image
  size across all episodes; `--width`/`--height` and `--decoder` apply
  to every episode.
- `--label`, `--max-items` and `--files` work only with one project (a
  usage error otherwise).
- Ledger: `projects` lists the projects' folder names in order; every
  `media` source (and `alsoFrom` source) carries `"project": N`
  (1-based, in that order); `inputs`, item `source`s and `report`
  sources read `epN:game/script.rpy:12`; the `rpyc*`/`rpa*` lists
  prefix strings the same way and give objects a `project`. Decoder
  hooks are still called with the bare source (`path`, or `archive` +
  `member`), without `project`.
- Rebuild with every project, in the same order:
  `kinetic-media rebuild <episode1> <episode2> [...] <out>`.

A helper that writes its own story ships each episode's media into the
same folder with `kinetic-media ship`, using the episodes' common parent
folder as `<game_root>` (sources such as `Ep1/game/images/a.png`), so the
merged media ledger rebuilds from that one root (kinetic-media ship,
below).

## Output layout

Every shipped media file, posters included, is content-addressed
(docs/plan.md Phase 25): it lands at `media/<h[:2]>/<h>.<ext>`, where
`<h>` is the sha256 of the bytes actually shipped and `<ext>` their true
format. `media/` is the one fixed folder name; there is no flat or
name-based option. The same bytes get the same path on every run and
machine, and identical outputs, whatever their sources, are one file
written once (one ledger `media` entry). The two-hex-digit
bucket spreads a big game over up to 256 shallow folders, because a
single huge directory is what macOS Finder stalls on.

A file already at its content path in the output folder (a re-run, a
ship into an existing folder, or a file hard-linked in from another
game or a test) is verified, not replaced (docs/plan.md Phase 26): when
its sha256 is the `<h>` in its name it is left untouched, keeping its
inode and any hard links; when it is not, the run stops with an error
naming the path, `<path>: existing file's sha256 is <got>, not the one
its name gives; not replaced (remove it, or use another output
folder)`, exit 1, and the file is not overwritten. This applies to
kinetic-extract, `kinetic-media ship` and `kinetic-media rebuild --out`.

Manifest `file`, `poster`, and `frames` values, and the ledger's item
`file`/`poster` and `media` keys, carry that relative subpath
(`media/4e/4e31ed53…882e.jxl`, a 64-hex stem), which the content format's
file-name rule allows; the player resolves it from the folder root and
never reads meaning into the name. Item ids no longer name files, so find
an item's file through the manifest or the ledger. A hand-authored folder
such as `fixtures/demo` may use any legal layout and stays flat.

Beside `media/`, kinetic-extract writes `manifest.json`, its
`manifest.js` shim, `build-ledger.json` and `manifest.schema.json`, a
byte copy of `docs/content-schema.json` that the manifest's first key,
`"$schema": "./manifest.schema.json"`, names (docs/plan.md Phase 51), so
an editor checks a hand-edited manifest against the schema of the
Kinetic release that wrote the folder (docs/content-format.md,
Manifest). The ledger, `kinetic-media rebuild` and `kinetic-media
posters` never read the copy, `tools/assemble_folder.py` leaves it
out of the folder readers get, and `tools/upgrade_folder.py` replaces it
with the current schema.

## Build ledger

`build-ledger.json` sits beside the manifest; the player and validator
ignore it. Besides the walk's record (`inputs`, `items`, `report`,
`branchDetection`, the `rpyc*`/`rpa*` source lists, `slice`, `walk`:
The walk follows labels, above, the
sound's `audioTracks` and video items' `sound`: Shipping the sound,
below, `transitions`: Colours and transitions, below, and
`translations`: Translations, below), it holds
enough to make every shipped media file again from the original game
files (docs/plan.md Phase 25), which `kinetic-media rebuild` reads:

- `mediaTools`: the tools this run used. `ffmpeg` and `ffprobe` as
  `{version, sha256}` (the version `-version` reports and the binary's
  hash), `Pillow`, `imagecodecs`, `libjxl`, `numpy`, `kinetic-extract`,
  `platform` (the media-tools platform that made the outputs, such as
  `macos-arm64` or `windows-x86_64`; a ledger without it, from before
  it was recorded, was made on `macos-arm64`), and `pinned` (false only
  under the test-only `KINETIC_MEDIA_TOOLS_DIR` override, whose output
  is not reproducible).
- `media`: one entry per shipped file, keyed by its path
  (`media/<h[:2]>/<h>.<ext>`), posters included:
  - `kind`: `image`, `video`, `poster` or `audio`; `sha256` and `bytes`
    of the shipped file.
  - `source`: where the bytes come from, relative to the project root
    (the folder holding `game/`, so a ledger works against any copy of
    the game): `{"path": "game/images/a.png"}` for a loose file, or
    `{"archive": "game/images.rpa", "member": "images/a.png"}` for an
    archive member; plus `sha256` and `bytes` of the raw source, before
    any carve, and, when several projects made one game, `project` (N,
    1-based: Several episodes, one game, above). A poster's source is
    its video.
  - `steps`: what was done to the source, in order. Each carries every
    parameter that decides the output bytes:
    - `{"step": "decode", "hook": "MODULE:FUNC", "hookSha256": "…",
      "inputSha256": "…", "outputSha256": "…"}`: a `--decoder` hook
      changed the bytes (Decoder hooks, below); always first, one per
      hook that changed them, in the order they ran. `hook` is the
      `--decoder` value as given, `hookSha256` the sha256 of the hook's
      source file, `inputSha256` the bytes it was given (the raw source
      for the first) and `outputSha256` what it returned.
      `source.sha256` stays the raw original's;
    - `{"step": "carve", "offset": N}`: drop the first N bytes (a
      wrapped image);
    - `{"step": "preserve"}`: ship the bytes unchanged. For an image
      that could have become JPEG XL, `reason` says why it did not
      (Image policy, below), e.g. `"jxl 10048 >= original 1306 bytes"`;
      a copied video's or audio file's `codec` is its ffprobe codec name
      (Video policy and Audio policy, below);
    - `{"step": "convert", "format": "png"|"jpeg", "params": {...}}`:
      decode with Pillow and save with these save parameters (`jpeg`
      also names the `mode` it converts to first);
    - `{"step": "jxl", "mode": "lossless", "pixels": "RGB", "effort": 9,
      "threads": 1, "verify": "pixels-identical"}`: libjxl lossless
      encode of the decoded pixels in that Pillow mode, decoded back and
      found identical; or `{"step": "jxl", "mode": "jpeg-recompression",
      "threads": 1, "verify": "jpeg-bytes-identical"}` for a JPEG's
      JPEG XL recompression, whose reconstruction gave back the original
      JPEG bytes exactly;
    - `{"step": "transcode", "args": [...]}`: the full ffmpeg argument
      list after the binary, `{input}` and `{output}` standing for the
      paths. A source with an odd width or height (H.264 yuv420p needs
      even ones) also has `-vf format=yuv444p,pad=W:H:0:0,fillborders=
      left=0:right=R:top=0:bottom=B:mode=smear` in `args`, with the
      literal even size and the 0/1 column/row added, and a `reason`;
      an even-sized source gets neither;
    - `{"step": "remux", "args": [...], "reason": "..."}`: a stream
      copy into MP4 (Video policy below), `args` as for `transcode`,
      `reason` why the source container or tag could not ship. An audio
      `remux` copies the first audio stream into WebM, M4A or MP3, and
      an audio `transcode` re-encodes it to Opus in WebM, or to AAC in
      M4A for a looping track (Audio policy, below); both carry a
      `reason`;
    - `{"step": "extract", "args": [...], "reason": "..."}`: the first
      audio stream of a video, copied or re-encoded by the same rule
      (Audio policy, below);
    - `{"step": "poster", "startSeconds": S, "args": [...],
      "frameFormat": "png", "mode": "RGB", "png": {"optimize": true}}`:
      the poster frame. ffmpeg runs `args` (`{input}` the video,
      `{output}` a `frameFormat` file; the frame is selected by `-ss S`
      after `-i`, an exact output seek, one frame, no scaling), then
      Pillow converts that frame to `mode` and saves it as PNG with the
      `png` save parameters. The next step is the still-image rule
      applied to that PNG: `jxl` (lossless, verified pixel-identical)
      when the JPEG XL is strictly smaller, else `preserve` with its
      `reason` (the PNG ships). The two steps are the complete poster
      recipe; running them again on the source gives the same bytes
      (Video policy, below). Ledgers written before lossless posters
      have a single `poster` step with `"jpeg": {...}` save parameters
      in place of `png` (RGB JPEG q90); rebuild still runs it and gets
      the same JPEG bytes. Nothing new ships with it.
  - `tools`: name to version for the tools the steps ran (from
    `mediaTools`); absent when nothing was encoded (`preserve`, `carve`).
  - `script` (audio only): `{"sha256", "bytes"}` of the script beside the
    file, `<path>.js` (docs/content-format.md, "The script beside each
    audio file"). It is made from the shipped bytes and their path
    alone, so it has no steps; `kinetic-media rebuild` makes it again
    from the rebuilt file. Ledgers written before scripts have no
    `script`, and their folders have none.
  - `alsoFrom`: other sources that made the same bytes, each with its own
    `source`, `steps` and `tools`; `source` is the first in item order.

- `decoders`: present when the run had `--decoder` hooks: each as
  `{"hook", "hookSha256"}`, in the order given, so a rebuild can require
  the same hooks with the same code.

Each item entry names its outputs with `file` and `poster` (keys into
`media`), its `asset` as a display string (`game/images/a.png`, or
`game/images.rpa!images/a.png` for an archive member), plus
`sniffedFormat`, `decision` and, for video, `codec`. An animation's
entry has `asset: null`, `decision: "frames"` and `frames`, one
`{asset, sniffedFormat, decision, file}` per frame (ATL frame lists,
above). Every dict in
`mediaTools` and `media` has sorted keys (step and argument lists keep
their order), so the same input gives the same ledger bytes. A shortened
example:

```json
"media/ef/ef6b02…4806.jxl": {
  "bytes": 102678,
  "kind": "image",
  "sha256": "ef6b02…4806",
  "source": {"bytes": 121094, "path": "game/data/photo-noise.png",
             "sha256": "…"},
  "steps": [{"effort": 9, "mode": "lossless", "pixels": "RGB",
             "step": "jxl", "threads": 1, "verify": "pixels-identical"}],
  "tools": {"Pillow": "13.0.0", "imagecodecs": "2026.10.10",
            "libjxl": "0.12.0", "numpy": "2.5.4"}
}
```

## Finding a script's files

A `scene` or `show` name resolves as Ren'Py resolves it: the game's
`image` definition first (a `Movie(play=...)` value answers as a video),
then the implicit image index of loose files and archive members (BUG 5
under Results, below): a file's path under `game/` without its
extension, then its file name without the extension, then Ren'Py's own
name for an image under `images/` (its "Images Directory" rule: the
file name without the extension, in lowercase, its directories
dropped, so `scene intro_shot_3` shows `images/Intro/Intro_Shot_3.jpg`),
loose files before archive members. `show screen x` shows a screen,
not an image: it is reported and changes no picture. A file name the script gives, in an `image`
definition, `Movie(play=...)` or `movie`, is looked up as Ren'Py's
loader looks it up, under each of `config.search_prefixes`, `""` then
`"images/"`: `game/<name>`, then `game/images/<name>`, then the
archives (their member with that key or a near match, then
`images/<name>`). So `image first = "day1/first shot.jpg"` plays
`game/images/day1/first shot.jpg` (docs/plan.md Phase 57 item 4d); the
item's ledger `asset` names the file found. A name found nowhere drops
its item (`droppedUnresolved`), as before.

### ATL frame lists

An `image name:` block of ATL (docs/plan.md Phase 60 item 8) is read
as a frame list when it holds only these statements, one per line or
joined by commas as Ren'Py allows:

- a frame: a quoted string, a file when it has a dot (as Ren'Py reads
  one), else an image name, resolved as `show` resolves a name (its
  `image` definition, a one-frame ATL image included, then the implicit
  index); a frame may end in `with <transition>`;
- `pause N` or a bare number `N`, the time the frame before it shows
  (several in a row add up);
- `pass`, `animation`, and `function name`;
- a last `repeat` or `repeat N`.

Such a block becomes an `animation` item wherever `scene` or `show`
names it (a name with attributes, `image door 2:`, included), and the
lines said over it are kept:

- `fps` alone when every frame shows as long (`1 / pause`), else
  `frameSeconds`, one per frame, with `fps` the frames over their sum
  (the even pace an older player plays);
- a bare `repeat` loops under the lines (`loopCount: 1`); `repeat N` is
  `loopCount: N` with `holdLastFrame: true`; no `repeat` is
  `loopCount: 1` held;
- a frame with no pause after it shows for no time in Ren'Py and is left
  out (reported), except the last frame of a block with no `repeat`,
  which Ren'Py shows from then on: it is the held frame and takes the
  block's shortest pause;
- a frame's `with` plays as a cut and a `function` is dropped, each
  reported.

Its frames ship as images through the usual image rule, so a picture
several animations or images use ships once; the item's ledger entry
has `decision: "frames"` and, under `frames`, each frame's `asset` and
image decision, and each frame has its own `media` entry, which
`kinetic media rebuild` checks as any other. An animated GIF or WebP
frame ships as it is (the image rule never re-encodes an animated
image), so the browser plays it inside its frame time. A block of one
frame, or whose frames are all one picture, is that picture as a still
`image` item; a one-frame block's transform properties (`zoom 1.5`,
`xalign 0.5`) are reported as not applied. A frame that resolves
nowhere drops the item and its lines, its `droppedUnresolved` reason
naming the frame.

Any other ATL keeps the block `image without a file`, reported at its
`image` line with the statement and its line named: ``image without a
file: ATL statement `linear 1.0 xalign 1.0` (game/script.rpy:4) not
converted``. That is motion (`linear`, `ease`, a
warper), `block`, `parallel`, `choice`, `on`, `contains`, `time`,
`event`, a pause before the first frame or not a number, a statement
after `repeat`, an expression frame (`Image("x.png")`), and a transform
property in a block of several frames.

## Image policy

docs/plan.md Phase 25. A browser-compatible still image (PNG, JPEG,
WebP, GIF) ships as lossless JPEG XL only when a verified JXL is
strictly smaller than the original; otherwise the original bytes ship
and the `preserve` step's `reason` says why.

| Source | JXL route | Verification | Kept original when |
| --- | --- | --- | --- |
| JPEG | JPEG XL recompression | reconstruction gives back the original JPEG bytes exactly (no pixel comparison) | libjxl refuses it (CMYK, for one: `jpeg recompression failed: JpegxlError`), the reconstruction differs, or the JXL is not smaller |
| PNG, GIF, lossless WebP | decode to 8-bit pixels (palette to RGB/RGBA, bilevel to L), libjxl lossless, effort 9, one thread | decoded JXL identical to the source pixels, compared in RGBA | 16-bit PNG, a pixel mode other than L/LA/RGB/RGBA/P/1, an embedded ICC profile that is not sRGB for these pixels (converting them to sRGB changes any; an sRGB one is dropped and the `jxl` step records `iccProfile`), an EXIF orientation other than 1, a pixel mismatch, or the JXL is not smaller |
| Lossy WebP | none | - | always, reason `lossy WebP: exact JPEG XL is always larger`: the exact JXL was larger in all 206 measured files (see Results) and cost about 27 s each. Read from the RIFF chunks before any decode: a `VP8 ` image chunk is lossy, `VP8L` lossless; in an extended `VP8X` file the first image chunk (inside the first `ANMF` frame when animated) decides |
| Animated GIF, WebP, PNG | none | - | always: the libjxl binding takes no frame durations or loop count, so an animated JXL could not be verified to keep the timing |
| `.jxl` | shipped as is | libjxl decodes the whole file (else the item is skipped) | - |

Other formats (BMP, TIFF, ...) are converted to the smallest of PNG,
JPEG q92 and JXL of the PNG, as before. Compared with the system `cjxl`
this replaced: `cjxl` read 16-bit PNGs and carried any ICC profile, so
16-bit and non-sRGB-profile images could become JXL; now they keep their
original bytes. (The 25.1 imagecodecs route before 25.5 fed a 16-bit RGB
PNG's 8-bit Pillow decode to libjxl and passed its own pixel check, a
silent precision loss now refused.) `cjxl` never read WebP; the pixel
route now reads lossless WebP.

## Video policy

docs/plan.md Phase 26 ("Video playability measured, not assumed",
superseding the earlier one video rule). Files must play in Safari and
Chrome. A local probe page of container x codec samples
(`.tmp/video-probe/`, decoded frames counted, not just audio) was run
on 2026-11-02 in Safari 26.6.2 on an M2 and in headless Chrome 156, and
the user agreed the rule below. Only the video track decides: the
player plays videos muted. Two tables in `kinetic_extract/assets.py`
hold it: `KEEP_VIDEO` (container -> codecs both browsers play there)
and `REMUX_VIDEO` (codecs both play in MP4).

The container comes from the bytes, never the name: for ISO-BMFF files
(ffprobe's `mov,mp4,m4a,3gp,3g2,mj2`) the `ftyp` major brand gives
`mov` (brand `qt`, or no `ftyp`), `m4v` (brand `M4V…`), `3gp` (a 3GPP
brand: `3gp…`, `3ge…`, `3gg…`, ...) or `mp4` (any other); for Matroska
files (ffprobe names every one `matroska,webm`) the EBML header's
DocType gives `webm` (DocType `webm` with VP8, VP9 or AV1) or `mkv`
(anything else); other files get ffprobe's first format name (`avi`,
`mpegts`, `mpeg`, `ogg`, ...). ffprobe also gives the first video
stream's codec and codec tag (`hvc1` or `hev1` for HEVC).

| Decision | When | Shipped | Ledger |
| --- | --- | --- | --- |
| keep (`copy`) | H.264 in MP4/MOV/M4V/3GP; HEVC tagged `hvc1` in MP4/MOV/M4V; VP9 in MP4/WebM/MKV; VP8 in WebM/MKV | byte-identical, at the true container's extension (`.mp4`, `.mov`, `.m4v`, `.3gp`, `.webm`, `.mkv`) | `{"step": "preserve", "codec": …}` |
| `remux` | H.264, HEVC or VP9 anywhere else (MKV, AVI, MPEG-TS, MPEG-PS, ...), or HEVC tagged `hev1` | the video stream copied unchanged into bitexact faststart `.mp4` (HEVC tagged `hvc1`) | `{"step": "remux", "args": […], "reason": …}` |
| `transcode` | any other codec: AV1, MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263, Theora, FFV1, VP8 outside WebM/MKV (Ogg), unknown | bitexact H.264 faststart `.mp4` | `{"step": "transcode", "args": […]}` |

AV1 is re-encoded because Safari on an M2 (no AV1 hardware decoder)
does not play it, though Chrome does. libx264 with yuv420p takes only
even dimensions, so a re-encoded source with an odd width or height
(a 180x101 AV1 clip) is padded by one column and/or row on the right
and bottom, filled with a copy of the last source column or row
(`fillborders` smear): no source pixel is cropped or resampled, no
border shows, and the picture grows by at most one pixel each way.
The padding runs on 4:4:4 pixels because padding odd-sized 4:2:0
frames gave different bytes from run to run with the pinned ffmpeg.
The poster is cut from the source, so it keeps the odd size. Even-sized
transcodes, and every remux (odd-sized H.264, HEVC or VP9 is copied, not
re-encoded), are unchanged. A remux keeps only the first
video stream (`-map 0:v:0 -c:v copy -an -sn -dn`): audio is dropped
because the player plays videos muted (a video's sound ships on its own,
Audio policy below), and one recipe with no
per-audio-codec table cannot fail on an audio, subtitle or attachment
track MP4 cannot hold (an MKV's fonts, a TS file's ADTS AAC). The same
video stream with different audio tracks therefore remuxes to one
shared file. The packets are those of the source (MKV and MP4 both use
length-prefixed H.264/HEVC, so their bytes are identical; MPEG-TS and
AVI carry Annex B start codes that the MP4 muxer rewrites, and the
decoded frames are identical). Kept files keep their audio untouched.

The probe results the rule rests on: both browsers played H.264 in
MP4, MOV, M4V and 3GP; HEVC (`hvc1`) in MP4, MOV and M4V (Chrome only
through the platform decoder, not with `--disable-gpu`); VP9 in MP4,
WebM and MKV; VP8 in WebM and MKV. H.264 and HEVC in MKV, AVI or
MPEG-TS, and HEVC tagged `hev1`, failed in at least one browser; so did
AV1, MPEG-4 Part 2, MPEG-2, MJPEG, ProRes, H.263, Theora and FFV1 in
every container, and VP8 in Ogg. Firefox was not probed. Every
converted probe sample (`.tmp/video-probe/converted/`, 78 clips: 29
kept, 18 remuxed, 31 transcoded) played in headless Chrome with the
GPU. A file ffprobe finds no video stream in is skipped (`unprobeable
video`); a failed remux or transcode drops the item.

Every shipped video has a poster: the frame at the item's `startSeconds`
(0 when unset), made by the ledger `poster` step above, lossless: a PNG,
or the JPEG XL of it when that is strictly smaller and decodes to
identical pixels (the Image policy's PNG rule), so a poster is `.png` or
`.jxl`. The player shows a `.jxl` poster as it shows `.jxl` images,
with the browser's own decoder. The poster is
made before the video ships. When ffmpeg or Pillow cannot make it, the
video item is dropped: nothing ships for it (no video, no poster),
`decision` is `skipped`, and the item note, the same text as its ledger
`warning`, reads `poster failed for <asset>: ffmpeg: <ffmpeg's error>:
item dropped from manifest`; the summary prints it as a `warning:` line
and counts it under `items skipped`. A dropped item is handled like any
other skipped one (a decision with a route item dropped is withdrawn).
The video never stands in as its own poster.

## Audio policy

docs/plan.md Phase 47, item 2. An `audio` request (kinetic-media ship,
below) ships a file that Chrome and WebKit both play and time right.
ffprobe gives the container, named as for video (an M4A is `mp4`),
and the first audio stream's codec; the file name never decides. A
stream with disposition `attached_pic` (MP3 or M4A cover art) is not a
video, so such a file is an audio file. Two tables in
`kinetic_extract/assets.py` hold the rule: `KEEP_AUDIO` (container ->
codecs kept there) and `COPY_AUDIO` (codec -> the container its stream
is copied into).

| Decision | When | Shipped | Ledger |
| --- | --- | --- | --- |
| keep (`copy`) | MP3 in MP3; AAC in MP4/M4A; PCM (`pcm_u8`, `pcm_s16le`, `pcm_s24le`, `pcm_s32le`, `pcm_f32le`) in WAV; FLAC in FLAC; Vorbis or Opus in WebM | byte-identical, at `.mp3`, `.m4a`, `.wav`, `.flac` or `.webm` | `{"step": "preserve", "codec": ...}` |
| `remux` | Vorbis or Opus in any other container (Ogg `.ogg`/`.oga`/`.opus`, CAF, Matroska), AAC elsewhere (ADTS, MOV, 3GP), MP3 elsewhere (WAV, Matroska) | the stream copied unchanged into `.webm`, `.m4a` (faststart) or `.mp3` | `{"step": "remux", "args": [...], "reason": ...}` |
| `transcode` | anything else: AIFF, ADPCM or big-endian PCM, ALAC, WMA, AC-3, MP2, FLAC outside FLAC, ... | Opus in `.webm` at 128 kb/s; more than 2 channels downmixed to stereo (`-ac 2` in `args`) | `{"step": "transcode", "args": [...], "reason": ...}` |

Ogg is never kept. Measured 2026-11-09 with a 12.000 s Vorbis tone in
headless Chrome 157 and the WebKit driver on macOS 27.2: in WebKit the
Ogg file reports 12.34 s and its clock runs 4-7% slow, and Chrome plays
it 0.8 s past its end, while the same stream copied into WebM is right
in both. Every copy uses `-map 0:a:0 -c:a copy -f <muxer>` plus the
bitexact output flags, and decodes to exactly the source's samples. An
MP3 copy gets `-write_xing 0 -id3v2_version 0`: with the Xing header
ffmpeg writes, its decoder would trim 529 samples the source never
trimmed.

Audio from a video: an `audio` request whose source has a real video
stream ships its first audio stream by the same codec rule, as an
`extract` step: AAC copied into `.m4a`, Vorbis or Opus into `.webm`,
MP3 into `.mp3`, anything else re-encoded to Opus in `.webm` (stereo
at most, as above). First
ffmpeg's `volumedetect` measures the stream's maximum level:

- below `SILENT_MAX_VOLUME_DB` (-70 dB), nothing ships and the
  decision is `silent`;
- no audio stream at all gives `no audio`, for any source.

Neither is an error, and neither changes the exit status, so a
converter can request every video's sound. The threshold comes from
the corpus, measured 2026-11-09 with the pinned ffmpeg on the 9,470
loose video files of 22 game folders: 2,309 carry an audio stream;
1,666 of those are digital silence, peaking at -91.0 dB (1,646) or
-90.3 dB (20), and the other 643 peak at -45.4 dB or louder, with
nothing in between.

Looping tracks. A request with `"loops": true` (kinetic-media ship,
below) is a track the player loops: music, ambience or a video's sound.
The player loops decoded samples, and some decoders shift the start, so
a loop in those formats restarts off its sample and may click
(docs/content-format.md, "Loop-safe formats"). The rule for such a
request is the table above, then one change: when the file would ship
as MP3, or as Opus in WebM, it is re-encoded to AAC in `.m4a` instead,
as a `transcode` step (an `extract` step for a video's sound):

| Source | Not looping | Looping |
| --- | --- | --- |
| MP3 in MP3 (or in WAV, Matroska) | kept (or copied) as `.mp3` | AAC `.m4a` |
| Opus in WebM | kept | AAC `.m4a` |
| Opus in Ogg, CAF, Matroska | copied into `.webm` | AAC `.m4a` |
| Vorbis in Ogg, CAF, Matroska | copied into `.webm` | copied into `.webm` |
| AAC, WAV PCM, FLAC, Vorbis in WebM | kept or copied | kept or copied |
| anything else | Opus `.webm` at 128 kb/s | AAC `.m4a` |

The re-encode uses ffmpeg's own AAC encoder at 192 kb/s (`-c:a aac
-b:a 192k`, more than 2 channels downmixed to stereo), into faststart
M4A (`-movflags +faststart -f ipod`) with the bitexact flags. The `-f
ipod` muxer records the encoder's priming in an edit list, so the
decode starts on the first sample. Why AAC: it starts exactly in Chrome
and WebKit, plays in every Safari the player supports and in both app
hosts, and the pinned ffmpeg has the encoder built in. Opus in Ogg also
decodes exactly, but Safari before 18.4 plays no Ogg. Vorbis in WebM
decodes exactly too, but Safari 15-17 playing it is not verified
(docs/plan.md Phase 47). Why 192 kb/s: about 64 kb/s a channel is the
usual rule of thumb for transparent AAC, ffmpeg's own encoder is not the
best one, and most such sources are lossy already, so 96 a channel for
stereo leaves room for both. Opus cannot be copied into any loop-safe
container every engine plays, so a looping Opus source is re-encoded
even from Ogg. The `reason` names the change, for example
`mp3 in mp3 loops, and as MP3 WebKit decodes it 576 samples late:
re-encoded to aac m4a at 192kb/s`.

A request without `loops`, or with `"loops": false`, ships by the table
above, as before. A source asked for both ways ships both files.

Scripts. Beside every audio file it ships, the asset pass writes the
file's script, `<path>.js` (docs/content-format.md, "The script beside
each audio file"), and records it as the ledger entry's `script` (Build
ledger, above). A script already in the folder with the right bytes is
left untouched; one with other bytes is replaced. Making it again costs
a base64 pass over the file, so the reuse cache keeps nothing for it: a
warm re-ship encodes nothing and rewrites no script. The player reads
only the scripts, so the copy `tools/assemble_folder.py` makes for play
leaves the audio files out (docs/packaging.md); `kinetic-media rebuild`
checks the converter's folder, which keeps both.

`durationSeconds` comes from decoding the shipped file: ffmpeg decodes
its first audio stream to PCM, and the sample count over the sample
rate, to 6 decimals, is the duration. Container headers can be wrong:
a VBR MP3 without a Xing header gives ffprobe a length from its first
frame's bitrate (2.93 s for a 2.04 s test file). A source that probes
but decodes to no samples (a WAV header with no data, say) is
`skipped` with a note; there is never a placeholder. ffprobe failing
on the source is `skipped` too (`unprobeable audio`), as is a failed
copy or re-encode.

## Reading Ren'Py audio

docs/plan.md Phase 47, item 8. kinetic-extract reads a game's audio
statements and attaches each cue to an item as the item's manifest
`audio` (docs/content-format.md, "Audio"): `music` (a track id, or null
to stop), `ambience` (the whole set of loops when it changed), `fadeMs`,
`sfx` (`{track, channel?}`) and `voice`. The tracks they name are
shipped and measured into the manifest's `audio.tracks` (Shipping the
sound, below), with the track fields that differ from their defaults:
`startSeconds`, `loopStartSeconds`, `volume`, and `loop: false` for
music played with `noloop`.

A track is one source file played one way, so a file played from two
start points, or at two volumes, makes two tracks that share one
shipped file. Track ids come from the file's base name (`theme`, then
`theme-2`), `epN-`-prefixed when several projects make one game.

What is read, by the rules of Ren'Py 8.3 (renpy/common/000statements.rpy,
00voice.rpy, 00audio.rpy and renpy/audio/):

- `play`, `queue` and `stop` on `music`, `sound`, `audio`, `voice` and
  any channel a script registers with `renpy.music.register_channel`
  and literal arguments (name, mixer, default loop, file prefix and
  suffix), with the clauses `fadein`, `fadeout`, `loop`, `noloop`,
  `if_changed`, `volume` and `channel`;
- `voice "file"`, through a literal `config.voice_filename_format`;
- `$ renpy.music.play(...)`, `queue(...)` and `stop(...)`, and the same
  three on `renpy.sound`, with literal arguments;
- file names as strings, `define audio.x = "file"` names, and the
  automatic names: every file under game/audio/ (any depth, loose or in
  an archive) with a `.wav`, `.mp2`, `.mp3`, `.ogg`, `.opus` or `.flac`
  extension is `audio.<base name, lowercased>`, the first path in
  sorted order winning a clash. A define wins over an automatic name;
- the partial-file specs `<from N>` and `<loop N>`, as `startSeconds`
  and `loopStartSeconds` (a loop point equal to the start is the
  default and is left out).

Files resolve as Ren'Py's loader finds them: the name as given under
game/, then under game/audio/, loose files before archive members,
compared without case in archives.

How a cue maps:

- `music` is the item's music, and `stop music` sets it to null.
- A looping play on any other channel puts that channel's loop in the
  ambience set, and stopping the channel takes it out. A play stops what
  its channel was playing, so a one-shot on a looping channel ends the
  loop.
- A play that does not loop is a one-shot whose `channel` is the Ren'Py
  channel. On `audio` each sound plays on a fresh sub-channel, so its
  one-shots have no `channel` and overlap, and `stop audio` reaches
  none of them. Two one-shots on one channel before the same item keep
  only the second, which cut the first.
- `voice` belongs to the next item that carries a line. A line dropped
  with its unresolved visual drops its voice.
- Loop defaults: `music` loops; `sound`, `voice` and `audio` do not; a
  registered channel loops unless registered with `loop=False`. An
  explicit `loop=None` loops up to Ren'Py 8.3 and not from 8.4, decided
  by the game's `renpy/vc_version.py`. `renpy.sound.play` loops only
  when asked.
- Each cue attaches to the next item emitted, the converting agent's
  rule (it matched an engine trace 99.7% and 99.8%). The cue of an item
  the asset pass drops passes to the next item kept, except its voice.
- `fadein` and `fadeout` become the item's `fadeMs`, the longest given;
  a change with neither keeps the format's default.
- `queue` with nothing before it on its channel plays like `play`.
  `if_changed` changes nothing: a wanted track is never restarted.

Menus. Audio statements in a choice block keep the menu, and a cue there
attaches to the route's first item; a menu nested in a route does the
same inside that route. A cue read just before a detected
menu reaches the first item of every route; each route starts from the
state before the menu; a cue after a route's last item stays on that
item. After the menu the last route's state goes on, and when the
routes left different ambience sets, the next ambience change is
reported.

Not converted, each reported with its statement in the ledger `report`
and the summary:

- playlists (the first file plays; a leading `<silence>` is skipped) and
  a `queue` after another track on its channel before the same item;
- `<silence N>`, and `<to N>` (the track plays to its end);
- `set_volume`;
- a file named by an expression, a variable, an undefined name or a
  name defined by an expression;
- creator-defined statements (`renpy.register_statement`): their names
  are matched before dialogue, as Ren'Py matches them;
- audio inside a skipped block (a screen, a transform, Python, an `if`)
  or an unsupported menu, and `$` audio Python other than the literal
  calls above (`renpy.play` included);
- a channel no script registers with literal arguments, and the movie
  channel, which plays video;
- `voice sustain`, a voice just before a menu, and a missing file (its
  cue is dropped, voice or not);
- a cue after the last item;
- a fade or volume given by an expression (ignored, the rest kept), and
  a volume outside 0-1 (clamped).

## Shipping the sound

docs/plan.md Phase 47, item 9. After the items ship, kinetic-extract runs
the asset pass again over `audio` records, the same records
`kinetic-media ship` makes for `audio` requests (Audio policy, above):

- one per source file that a kept item's cue names, loose or an `.rpa`
  member, through the `--decoder` hooks. A track named only by a dropped
  item (a voice line that went with its line, a cue after the last item
  kept) is not shipped;
- one per video file of a kept video item, for its own sound.

A source that a kept item plays as music (a track without `loop:
false`) or as ambience, and every video file, is a looping record, as
a kinetic-media request with `"loops": true` is: it ships in a
loop-safe format (Audio policy, above). One-shots and voice lines ship
by the plain rule. Each lands in `media/` with its script and in the
ledger's `media` (kind `audio`, steps `preserve`, `remux`, `transcode`
or `extract`), so `kinetic-media rebuild` checks it like any other
output. A shipped track becomes
`audio.tracks.<id>` with `file`, the decoded `durationSeconds` and its
other fields. Then:

- A track whose file ships nothing (it does not probe or decode, say) is
  dropped, and so are its cues, as a missing file's are: its `music`
  change, `voice` and one-shots go, and it leaves every `ambience` set
  (the rest of the set stays). A fade with no change left goes too.
- A track whose `startSeconds` is not before its measured end is dropped
  the same way: nothing would play.
- A track whose `loopStartSeconds` is not before its end keeps playing
  from its start, once: it gets `loop: false` and no loop point. Ren'Py
  restarts such a loop past the end, which plays nothing.
- A video item whose sound ships and lasts to the item's range end
  (`endSeconds`, else `durationSeconds`) within 0.05 s, the format's
  rule, gets `videoSound: {track}`, `duck` left at its default 1. The
  track id is the video file's base name; items of one video file share
  one track. A sound that is `silent`, has no audio stream (`absent`),
  failed, or is shorter than the range end is not used; the last two
  get an item note.
- When no track ships at all, no item keeps `audio`: a `stop music` or
  an emptied ambience set would stop sound that never played, and
  item `audio` with no `audio.tracks` does not validate.

Each dropped or changed track is reported, with its source file and
`track <id>`, in the ledger `report` and the summary. A shipped file no
track uses (a too-short soundtrack, a track dropped for its start)
stays in `media/` and the ledger: the extractor never deletes files.

The build ledger records:

- `audioTracks`: every track tried, by id: `asset` (the source file, as
  item assets are named; a video's sound names its video), the audio
  `decision`, the shipped `file` and the asset pass's `notes` plus the
  reason a track was dropped or changed;
- each video item's `sound`: the decision for its sound (`extract`,
  `silent`, `no audio`, `skipped`).

The summary counts both:

```text
audio: 5 items carry sound; 6 tracks shipped (3 copy, 1 extract, 2 transcode), 0 dropped
video soundtracks: 1 audible, 0 silent, 1 absent
```

`too short` and `failed` join the second line when there are any.
fixtures/renpy_demo has music, an ambience loop on a registered channel,
a one-shot, a voice line, a music change and a stop in a choice block,
a movie with an audible MP3 soundtrack and one with no audio stream.
The ambience, the one-shot and the voice line ship byte-identical. The
music loops and the soundtrack is a video's sound, so both MP3s are
re-encoded to AAC; those bytes, and the length ffmpeg decodes from
them, depend on the ffmpeg version, so the golden manifest test
compares those two tracks by format, and the rest exactly.

## Decoder hooks

Some games wrap or obfuscate their media. Kinetic carves a plain wrapper
(a PNG/JPEG signature within the first 64 bytes, after which the bytes
must decode as a whole image), but it does not ship game-specific
decoders. A game's conversion package provides one as a Python function
and passes it with `--decoder MODULE:FUNC` (docs/plan.md Phase 25):

```sh
.venv/bin/kinetic-extract <game> <out> --decoder ./my_game/unwrap.py:decode
```

- MODULE is an importable module name (`my_package.unwrap`) or a path to
  a `.py` file; FUNC follows the last `:`. A module that cannot be
  imported, or no such function, is a usage error (exit 2) before any
  work.
- `FUNC(data: bytes, source: dict) -> bytes | None` is called once per
  media source the asset pass reads (images, videos and audio), loose
  file or `.rpa` member, with the source's COMPLETE bytes (a wrapper's
  layout may depend on the file length), before format detection and
  carving.
  `source` is a copy of the ledger source ref: `{"path":
  "game/images/a.png"}` or `{"archive": "game/images.rpa", "member":
  "images/a.png"}`.
- Return `None` for data that is not yours (unchanged), or the decoded
  bytes. Returning anything else stops the run.
- Data you recognise but cannot decode (malformed, truncated): raise.
  The run stops with exit 1 and `kinetic-extract: decoder hook
  MODULE:FUNC failed on <source>: <ErrorType>: <message>`, before the
  manifest and ledger are written. A recognised source is never silently
  skipped.
- `--decoder` repeats; the hooks chain in the order given, each getting
  the previous one's output, so one hook can unwrap what another exposed
  and hooks for unrelated wrappers coexist by returning `None`.
- A decoded video's `durationSeconds` is probed from the decoded bytes.
- The hook runs in-process with the converter's trust: use only code you
  have read. The ledger records it (Build ledger: the `decode` step and
  `decoders`); give MODULE as a module name or a path relative to where
  you run if ledgers from different machines should match byte for
  byte. A module name resolves through `PYTHONPATH`, e.g.
  `PYTHONPATH=~/games/rainy-kinetic ... --decoder rainy_unwrap:decode`,
  which records `rainy_unwrap:decode` on every machine.
- `hookSha256` hashes only the file that defines MODULE, not modules it
  imports: keep a hook in one self-contained file so the hash covers
  all of its code.

CREATE.md ("A game that wraps its media: decoder hooks") walks through
writing, packaging and passing a hook. Its EXTRA example, like the
repo's test hook (`converter/tests/extra_hook.py`, applied to synthetic
files only), is illustrative: it is not a correct decoder for any game,
the converted corpus game it was modelled on included (its episodes 4-5
use an activation-dependent offset), and that game's real hook lives in
its own conversion package.

## kinetic-media ship

A game-specific helper that builds the story itself can hand all media
work to Kinetic without a story parse (docs/plan.md Phase 25; a worked
example is in CREATE.md, "Writing your own converter: kinetic media
ship"):

```sh
.venv/bin/kinetic-media ship <game_root> <out> --list requests.json \
    [--decoder MODULE:FUNC ...] [--jobs N] [--video-jobs N]
```

Each request goes through the same asset pass as kinetic-extract: the
decoder hooks, the Image, Video and Audio policies, posters, and
content-addressed placement under `<out>/media/`. The same sources give
the same paths and `media` entries as kinetic-extract. The pinned tools'
self-test runs first, as for kinetic-extract.

The list is one JSON array. Source paths are relative to `<game_root>`,
in POSIX form, and may not be absolute or contain `..`:

```json
[
  {"source": {"path": "game/images/a.png"}, "kind": "image", "id": "q1-a"},
  {"source": {"archive": "game/images.rpa", "member": "bg/room.jpg"},
   "kind": "image"},
  {"source": {"path": "scenes/intro.webm"}, "kind": "video",
   "startSeconds": 2.5},
  {"source": {"path": "game/audio/rain.ogg"}, "kind": "audio",
   "loops": true, "id": "rain"},
  {"source": {"path": "game/audio/knock.mp3"}, "kind": "audio",
   "id": "knock"},
  {"source": {"path": "scenes/intro.webm"}, "kind": "audio",
   "loops": true, "id": "intro-sound"}
]
```

- `source`: `{"path"}` for a loose file, or `{"archive", "member"}` for
  an `.rpa` member (the archive path, and the member key exactly as the
  archive stores it).
- `kind`: `"image"`, `"video"` or `"audio"`. An `audio` request of a
  video ships its sound (Audio policy, above).
- `startSeconds` (videos only, a number >= 0): the poster is the frame
  at that time. The default is 0.
- `loops` (audio only, `true` or `false`, default `false`): the track
  loops, as music, ambience or a video's sound do, so it ships in a
  loop-safe format (Audio policy, above). Leave it out for one-shots
  and voice lines.
- `id` (optional, a non-empty string): the helper's own key. It must be
  unique within one list.

A malformed list is refused before any work. The run exits 2 and
names each bad entry by its position, e.g. `request 2: kind must be
"image", "video" or "audio", got 'sound'`.

`<out>/media-ledger.json` holds `generatedBy`, then `mediaTools`,
`decoders` and `media` exactly as in the build ledger (Build ledger,
above), then `requests`. Each request is echoed as given, with paths
normalized, and paired with its result:

```json
{"request": {"kind": "video", "source": {"path": "scenes/intro.webm"},
             "startSeconds": 2.5},
 "result": {"codec": "vp9", "decision": "copy", "durationSeconds": 12.0,
            "file": "media/3f/3f…e1.webm", "height": 720,
            "notes": [], "poster": "media/9a/9a…07.jxl",
            "sniffedFormat": "webm", "width": 1280}}
```

An audio request's result, for a looping Ogg Vorbis file:

```json
{"request": {"id": "rain", "kind": "audio", "loops": true,
             "source": {"path": "game/audio/rain.ogg"}},
 "result": {"codec": "vorbis", "decision": "remux",
            "durationSeconds": 30.002, "file": "media/5c/5c...a2.webm",
            "notes": ["vorbis in ogg is not kept: copied into webm"],
            "sniffedFormat": "ogg"}}
```

- `file`, plus `poster` and `durationSeconds` for a video: the values
  for the manifest item. An audio request's `file` and
  `durationSeconds` (decoded, Audio policy above) are the values for
  its track; its script is `<file>.js`, beside it.
- `width`/`height`: the display size, read from the shipped image or
  from the poster frame; an audio result has none.
- `decision`, `sniffedFormat`, `codec`, `notes` and `warning`: as in a
  build-ledger item entry.
- A request with no `file` shipped nothing. Its `decision` is
  `missing-source` (no such file, `archive not found`, `member not in
  archive`), `skipped` (not a usable image, video or audio file, audio
  that does not decode, or a failed poster), or, for an `audio`
  request, `silent` or `no audio`; its notes say why. The helper drops
  that item or track.

Exit codes:

- 0: every request ran. Skipped requests do not fail the run; the
  summary line `requests: N; shipped: M; skipped: K` lists each one
  with its reason. Audio requests that were `silent` or `no audio` are
  added as `; no sound: S` and listed too.
- 1: a decoder hook raised (the ledger is not written), or the folder's
  existing ledger cannot be merged into.
- 2: a bad list or game root, or media tools that are not ready.

Shipping into a folder that already has a `media-ledger.json` merges
into it, so a helper can ship once per episode into one folder:

- Its `media` entries are kept. An output made again by its own source
  changes nothing; one made by a new source adds that source under
  `alsoFrom`.
- A request with an `id` replaces the earlier request with that `id`,
  in place. A request without one replaces an identical earlier request.
  Any other request is appended. Shipping the same list twice therefore
  changes nothing, and shipping list A and then list B gives the same
  folder as shipping A followed by B in one list.
- `decoders` gains any hook not already listed.
- A ledger made with different `mediaTools` is refused (exit 1): one
  folder's media must rebuild with one tool set, so ship into a new
  folder. That includes the platform, so one ledger's outputs are
  always made on one platform (a ledger without `platform` counts as
  `macos-arm64`).
- An output its ledger already records for the same source, made by
  the same steps with the same tools, and still in `media/` with its
  sha256, is reused as it stands: a transcode or remux is not run
  again, with or without the reuse cache. A poster made by the same
  frame recipe is reused with whichever image step it took.
- Files are never deleted unless asked. An output that only a replaced
  request used stays in `media/`. Poster files no request (nor a
  `manifest.json` or `build-ledger.json` in the folder) names any more
  are counted in the summary (`unreferenced posters: N kept`);
  `--delete-unreferenced-posters` deletes them and drops their ledger
  entries (`unreferenced posters: N deleted`), after the new ledger is
  written. Only `poster` entries are ever deleted, never one still
  named.

### Parallel workers

`ship` and `rebuild` take two limits:

- `--jobs N`: run up to N encodes at once (default: one per core,
  `os.cpu_count()`). `--jobs 1` runs everything in order on one
  thread, as before.
- `--video-jobs N`: of those, at most N transcodes or remuxes, video
  or audio, and audio extracts (default: a quarter of `--jobs`, at
  least 1). A waiting transcode takes the next free slot before any
  waiting still image, so long transcodes start early instead of last.

The folder is the same whatever the limits: the same files, the same
bytes, and a byte-identical `media-ledger.json`. How `ship` keeps it
so (`converter/kinetic_extract/workers.py`, `assets._plan_ahead`):

- First one coordinator walks the requests in order. It reads and
  hashes each source, runs the decoder hooks, sniffs images and probes
  videos and audio (each file once), and queues every encode the
  requests need: an image decision, a poster, a transcode or a remux.
  An audio source's task is its whole slow part: a video's loudness
  check, the copy or re-encode, and the decode for the duration. Each
  is keyed by what it encodes (the input's sha256, plus `startSeconds`
  for a poster), so an encode many requests share is queued once. An output
  the folder's ledger already records is not queued.
- Worker threads run the queue. libjxl, zlib and ffmpeg release
  Python's lock, so threads run truly in parallel and no frame is
  copied between processes. Each encode is still single-threaded
  (`numthreads=1`, `-threads 1`); the speed comes from running several
  at once. A finished output waits in a scratch file, not in memory.
- The coordinator then places the requests one by one, in request
  order, with the same code as `--jobs 1`. It takes each result as it
  is needed, so ledger entries, `alsoFrom` order and notes cannot
  depend on which worker finished first.
- Every output is written to the scratch folder (inside `<out>`, on
  the same disk) and renamed into `media/`. The ledger is written once,
  at the end, to a temporary file that is then renamed. A crash or
  kill therefore never leaves a half-written output or ledger. The
  folder's earlier ledger stays as it was, and any outputs already in
  `media/` are whole.

`rebuild` checks each ledger entry on a worker. Failures are still
listed in ledger order.

Progress goes to stderr at most every 10 seconds, plus a last line:

```text
progress: 5120/87000 (5.9%), 41m10s elapsed, ~10h58m left
```

It counts requests (for `rebuild`, ledger entries) in ledger order, not
distinct outputs, since several requests can share one output file.
The estimate assumes the remaining requests take as long as the
finished ones did.

Measured on an 8-core M2 (4 performance + 4 efficiency cores, 16 GB),
cold (`KINETIC_MEDIA_CACHE=off`), with the pinned tools, on 132
requests for 120 synthetic 1920x1080 six-second videos (124 distinct
posters, all shipped as JPEG XL); see the table below.

Posters only: 132 requests, 124 distinct posters.

| `--jobs` | Wall time | Peak memory | Same folder as before |
| --- | --- | --- | --- |
| before this change (serial) | 1649 s | 0.22 GB | (reference) |
| 1 | 1648 s | 0.20 GB | yes |
| 2 | 828 s | 0.39 GB | yes |
| 4 | 477 s | 0.68 GB | yes |
| 6 | 382 s | 0.84 GB | yes |
| 8 (default) | 357 s | 1.07 GB | yes |

Mixed: 27 requests, 9 needing a transcode (MPEG-4 Part 2) and 18
copied, 25 posters.

| `--jobs` / `--video-jobs` | Wall time | Peak memory | Same folder |
| --- | --- | --- | --- |
| before this change (serial) | 365 s | 0.16 GB | (reference) |
| 1 / 1 | 360 s | 0.15 GB | yes |
| 2 / 1 | 188 s | 0.28 GB | yes |
| 4 / 1 | 111 s | 0.43 GB | yes |
| 8 / 2 (default) | 88 s | 0.86 GB | yes |
| 8 / 4 | 86 s | 0.78 GB | yes |
| 8 / 8 | 86 s | 0.81 GB | yes |

`rebuild` of the mixed folder: 242 s with `--jobs 1` and 62 s with 8,
with the same report.

Another single-threaded conversion was using one core throughout these
runs. Going from 4 to 8 jobs adds the four efficiency cores, which
encode about half as fast. The pinned transcode recipe is
single-threaded (`-threads 1`), so `--video-jobs` hardly changes the
total.

Each JPEG XL encode of a 1080p frame takes about 10 s on a
performance core and about 0.12 GB of memory. The defaults are one job
per core, which is the fastest measured: 8 jobs used about 1.1 GB here.
On a machine short of memory, lower `--jobs`.

A run killed partway writes no ledger, so a restart reuses only what
the reuse cache (Reuse cache, below) holds. With the cache on (the
default), a restart re-reads and hashes every source but encodes
nothing it finished before. With `KINETIC_MEDIA_CACHE=off`, it encodes
everything again.

### Regenerating the posters of an existing shipment

A shipment made before lossless posters has JPEG posters. Ship the same
request list into the same folder again, with the same pinned tools:

```sh
.venv/bin/kinetic-media ship <game_root> <out> --list requests.json \
    [--decoder MODULE:FUNC ...]
.venv/bin/kinetic-media rebuild <game_root> <out> [--decoder ...]
```

Each video is reused from the ledger (copied ones re-hashed, transcodes
and remuxes not run), each poster is made with the lossless recipe, and
each request's `result.poster` (and `width`/`height`) now names the new
file. Rebuild the helper's manifest from the new results. The old JPEGs
stay, counted as unreferenced, and still rebuild; once the manifest
uses the new posters, run the same ship again with
`--delete-unreferenced-posters` to remove them (nothing is encoded the
second time). Requests left out of the list keep their JPEG posters.

Ship every episode from the same `<game_root>`, the folder holding all of
them, with sources naming the episode folder
(`{"path": "Ep2/game/images/a.png"}`) and ids unique across episodes
(`ep2-room`). The merged ledger then names every source against that
one root, and `kinetic-media rebuild <that folder> <out>` checks them
all. Shipping each episode from its own root instead gives a ledger whose
sources rebuild only against that root: rebuild reports the other
episodes' sources missing or mismatched.

## kinetic-media rebuild

Makes a folder's media again from its ledger and the original game
files, and checks every hash (docs/plan.md Phase 25):

```sh
.venv/bin/kinetic-media rebuild <game_root> [<game_root> ...] <folder> \
    [--decoder MODULE:FUNC ...] [--out DIR] [--jobs N] [--video-jobs N]
```

`--jobs` and `--video-jobs` work as for ship (Parallel workers, above).

- `<folder>` holds `build-ledger.json` (kinetic-extract),
  `media-ledger.json` (kinetic-media ship), or both. With both, both
  `media` sections are rebuilt, and together they must account for the
  folder's `media/`.
- `<game_root>` is the original game. A build ledger's `game/...`
  sources resolve against the project as kinetic-extract takes it (the
  project dir, `game/` itself, or a macOS `.app`). A media ledger's
  sources resolve against `<game_root>` as given, the same root the
  ship ran with.
- Several game roots: for a game kinetic-extract made from several
  projects, give each project, in the same order; a source with
  `"project": N` resolves against the Nth (a missing one fails, naming
  the project). A source without `project` uses the first, as does a
  media ledger (ship each episode from their common parent folder).
- `--decoder`: the hooks the conversion ran, in the same order. A hook
  matches a ledger hook by function name and code sha256. The module
  path may be spelled differently, for example after the hook package
  moved; its code may not change.
- `--out DIR`: also write the rebuilt `media/` tree into `DIR`. Only
  the ledger is needed, so this reproduces a game's media from the
  original files. A file already present in `DIR` is verified and left
  untouched (Output layout, above); one whose bytes do not match its
  name is a `FAIL <output path>: <path>: existing file's sha256 is …`
  line, never overwritten. To repair a folder's altered file, rebuild
  into a new `DIR` and copy its `media/` over. Without `--out` the rebuild only
  verifies: outputs go to a temporary dir that is deleted afterwards,
  and the folder is not written.

The pinned tools' self-test runs first. A ledger made on another
platform is refused before anything runs (exit 3), one line per
ledger: `build-ledger.json: made on windows-x86_64; rebuild there to
verify (this machine is macos-arm64)`. Some recipes give other bytes on
another CPU (`selftest.cpuDependent` in `converter/media-tools.json`:
the AAC and Opus encodes, the poster frame and its JPEG, the H.264
transcodes), and the ffmpeg binaries differ per platform anyway, so
this applies to every output of the folder, not only those recipes. A
ledger without `mediaTools.platform`, from before ledgers recorded it,
counts as made on `macos-arm64`, the only platform pinned then. The
ledger's `mediaTools` must
equal this run's tools exactly, or the rebuild refuses (exit 2) and
names each difference (`mediaTools Pillow: ledger "13.0.0", now
"13.1.0"`). `mediaTools` includes the ffmpeg and ffprobe binaries'
sha256, which differ per platform, so a folder rebuilds on the OS and
architecture that made it, with a Kinetic checkout whose pins match
(the commit that made it is the safe choice). With the same pinned tools every output must come out
byte-identical, so there is no tolerance for drift. The rebuild never
reads the reuse cache (below): it runs every step again, because
verifying means encoding.

For each `media` entry, and separately for each of its `alsoFrom`
sources:

1. Find the source under the game root and check its `sha256` and
   `bytes`.
2. Run its recorded `steps` in order through `assets.run_steps`. This
   is the same step code the converter makes its outputs with: each
   candidate is made by running the step dict that is then recorded,
   so recipe and code cannot drift. Audio entries run their
   `preserve`, `remux`, `transcode` or `extract` step like any other,
   each written at its muxer's extension. The decoder hooks run first,
   as in the asset pass, and the `decode` steps they make must equal
   the recorded ones.
3. Check the output's sha256 against the entry's.
4. For an entry with a `script`, make the script again from the rebuilt
   file and its path, and check its sha256 and size against the
   entry's `script`. `--out` writes it beside the file.

The folder's `media/` is then checked against all entries, an audio
entry's script included. It is
always checked without `--out`, and with `--out` only when the folder
has a `media/`.

Every failure is one line, `FAIL <output path>: <problem>`; an
`alsoFrom` source reads `<output path> (also from <source>)`:

| Problem | Meaning |
| --- | --- |
| `missing source game/a.png` | no such file; for an archive member, `(archive not found)` or `(member not in archive)` is added |
| `source hash mismatch for …: expected …, got …` | the original file changed |
| `decoder hook missing: MODULE:FUNC` | no `--decoder` with that function and code |
| `decoder hook mismatch: FUNC (given …, ledger …)` | a hook of that name was given with other code |
| `decode steps differ from the ledger …` | the given hooks change the source differently |
| `unsupported step 'NAME'` | a step (or a `jxl` mode, or a `convert` format) this converter cannot run |
| `step NAME failed: …` | ffmpeg, Pillow or libjxl failed |
| `output mismatch: expected <sha256>, got <sha256>` | the rebuilt bytes differ |
| `script mismatch: expected …, got …` | on `<output path>.js`: the script made from the rebuilt file is not the entry's `script` |
| `not in the ledger` | a file in the folder's `media/` that no entry lists |
| `absent from the folder` | an entry whose file is missing from `media/` |
| `folder file differs from the ledger: …` | the folder's file is not the entry's bytes |

Hook problems against the ledger's `decoders` list are also reported
under `decoders:`. A given hook that no ledger lists counts too.

The summary reads `build-ledger.json: 8 outputs from 8 sources: 8
matched, 0 failed`, then `rebuild OK`, or `rebuild FAILED: N
problem(s)`.

Exit codes:

- 0: everything matched.
- 1: anything missing, unsupported or mismatched, each named.
- 2: the rebuild cannot start: no ledger in the folder, a ledger with
  no `media` section, other media tools, a bad game root, or tools that
  are not ready.
- 3: a ledger was made on another platform: rebuild on the platform
  each `made on <platform>` line names.

## kinetic-media posters

Checks that every video item's poster is the frame at the item's
`startSeconds`, as docs/content-format.md ("Video playback ranges")
requires, and with `--fix` ships the posters that are not
(docs/plan.md Phases 44 and 45):

```sh
.venv/bin/kinetic-media posters <game_root> <folder> [--manifest FILE] \
    [--ledger FILE] [--items FILE] [--first-frame FILE ...] \
    [--first-frame-all] [--decoder MODULE:FUNC ...] \
    [--fix --remap FILE] [--out FILE] [--jobs N] [--video-jobs N]
```

- `<game_root>`: the root the folder's media was shipped from. Ledger
  source paths are relative to it (for a kinetic-extract folder, the
  project folder holding `game/`).
- `<folder>`: the Kinetic folder holding `media/` and its ledgers.
- `--manifest FILE`: the manifest to check (default
  `<folder>/manifest.json`), for example a staged draft kept elsewhere.
  Its `file` and `poster` paths are read from `<folder>`.
- `--ledger FILE`: check against that ledger alone. The default is the
  folder's `build-ledger.json` and/or `media-ledger.json`, read together
  as `rebuild` reads them.
- `--items FILE`: check, and fix, only the items it lists (Checking one
  shipment, below).
- `--decoder`: the hooks the media was shipped with, in the same order.
- `--jobs N`: up to N pixel comparisons at once. `--fix` ships with
  `--jobs` and `--video-jobs` (Parallel workers, above).

The pinned tools' self-test runs first. The ledgers are read once into
one lookup by media path: 10,000 items against a 174 MB ledger of
113,000 entries took about 1 s.

### The pass rule

Every `video` item is checked. Route items are spans of the one
`items` array (docs/content-format.md, "Branches"), so this covers every
route. An item without `startSeconds` starts at 0.

- By ledger: the poster passes when a ledger record that made it (its
  `media` entry or any `alsoFrom` source) has a `poster` step at the
  item's `startSeconds`, made from a source whose sha256 also made the
  item's video file. Both poster recipes, lossless and the older JPEG,
  record `startSeconds`. Starts are compared as the recipe uses them, to
  six decimals. A recorded other start or other source fails. An item
  that passes this way is not decoded.
- By pixels, when the ledger cannot say: the poster or the video has no
  ledger entry, or the poster's steps record no `startSeconds` (a
  hand-made or edited ledger; a missing start is not read as 0). The
  poster and the frame at `startSeconds` are decoded with the pinned
  tools and compared as 8-bit RGB. The frame comes from the video's
  original source when a ledger record names it and it is still under
  `<game_root>` with the recorded sha256 (after the decoder hooks), else
  from the folder's video file. A frame one column or row bigger (a
  transcode pads an odd size) is cropped to the poster. The poster
  passes when the mean absolute difference per channel (0-255) is at
  most 3.0.

The limit (`POSTER_TOLERANCE`, `converter/kinetic_extract/posters.py`)
comes from measurements with the pinned tools on five 1080p VP9 videos
from two corpus games, a 1080p VP8 video, and synthetic test patterns
and gradients (2026-11-09):

| Comparison | 1080p game video | Synthetic 640x360 |
| --- | --- | --- |
| a correct older JPEG q90 poster against the exact frame | 0.02-1.36 | up to 2.04 |
| the frame of the folder's H.264 transcode against the source's | 0.04-1.23 | up to 0.96 |
| a correct JPEG q90 poster against the transcode's frame | up to 1.51 | up to 2.31 |
| frame 0 against the frame at a later start | 0.75-108 | 5.5-150 |

3.0 passes every correct case at 640x360 and up. Of the 19 real later
starts measured, 15 differ from frame 0 by more than 3; the other four
are a near-static logo fade (0.75) and slow loops of one moving figure
(2.53-2.74). Tiny, sharp test patterns (96x54, 160x90) push a correct
JPEG q90 poster to 3-9; such a poster fails, and `--fix` only ships a
lossless one in its place.

### Report and exit codes

One line per failing item, then a summary:

```text
FAIL ep2-17: file media/3f/3f…e1.webm, startSeconds 2.5, poster startSeconds 0.0, difference 31.42 (ledger: poster made at another start), start luma 48.3, poster luma 52.0
FAIL ep2-30: file media/8a/8a…07.webm, startSeconds 0, poster startSeconds 3.0, difference 71.06 (ledger: poster made at another start), start luma 0.0, poster luma 71.1, dark start
posters: 144 video items: 144 checked, 10 passed (10 by ledger, 0 by pixels), 134 failed, 0 skipped (first frame)
```

A `FAIL` line gives the item's id, `file` and `startSeconds`, the
poster's recorded `startSeconds` (`none` when the ledger records none),
the pixel difference (`unknown` when the poster or the frame cannot be
decoded), why, and the two frames' luma:

- why: `ledger: poster made at another start` or `ledger: poster made
  from another source`; or `pixels: poster not in the ledger`,
  `pixels: video not in the ledger` or `pixels: the ledger records no
  poster startSeconds`, followed by `above 3.0` or what could not be
  decoded.
- `start luma` and `poster luma`: the mean Rec. 601 luma (0.299 R +
  0.587 G + 0.114 B, 0-255) of the frame at the item's start and of the
  poster, from the frames the pixel difference decoded (no extra
  decoding). With no difference, both are `unknown`.
- `dark start`, when the start frame's luma is below 6.0.

A dark start next to a brighter poster suggests the poster was moved
past a black or fade-in lead-in on purpose. The check still fails it:
docs/content-format.md makes the poster the frame at the item's start,
black or not.

The threshold (`DARK_START_LUMA`, `converter/kinetic_extract/posters.py`)
was measured with the pinned tools on synthetic fade-in clips and on
452 videos from two corpus games (2026-11-09):

| Frame | Mean luma |
| --- | --- |
| frame 0 of a fade-in from black (three synthetic clips, one game cutscene) | 0.0 |
| a game video's near-black first 0.25 s (26 after it) | 1.7 |
| one frame into a synthetic 1.5-2 s fade at 24 fps (two frames in) | 1.5-2.4 (2.9-5.2) |
| a game's credits video | 9.9-11.9 |
| 73 game videos named as night scenes | 10.8 at the darkest, median 36 |
| every other game frame measured (first 1-3 s) | 13.1 and up, medians 64 and 90 |

6.0 sits in the gap between the brightest near-black start (2.4) and
the darkest real picture (9.9).

`checked` counts the items not skipped; it is `passed` plus `failed`.

Exit codes:

- 0: nothing fails.
- 1: anything fails (with `--fix`: anything is not fixable).
- 2: it cannot start: no manifest or ledger, a bad game root, media
  tools not ready, or bad arguments (`--fix` without `--remap`,
  `--remap` or `--out` without `--fix`, `--fix` with a `--ledger` other
  than `<folder>/media-ledger.json`, an `--items` file that cannot be
  read or parsed, or one listing an id that is no manifest item).

The check writes nothing: not the folder, a ledger or the reuse cache.
Frames are decoded in a temporary directory that is deleted afterwards.

### First-frame posters

docs/content-format.md lets a folder that cannot decode to seek keep
the file's first frame as the poster. `--first-frame FILE` (repeatable,
a manifest video `file` value) skips that file's items, and
`--first-frame-all` skips every video item. Skipped items count under
`skipped` and are never reported or fixed. The ledger format does not
change.

### Checking one shipment: --items

`--items FILE` limits the check, and `--fix`, to the items it lists,
for a delivery gate that checks only the shipment being delivered. The
file is either:

- a JSON array of item id strings, when its first non-blank character
  is `[` (anything else in a file that starts that way, such as a
  number in the array or a JSON syntax error, exits 2); or
- one id per line: each line is stripped, and blank lines and lines
  starting with `#` are ignored.

```text
# shipment 3
ep3-001
ep3-002
```

Rules:

- An id that is no manifest item's id exits 2 and is named (the first
  10, then how many more), so a typo cannot gate nothing. Branch and
  route ids are not item ids.
- The id of an item that is not a video is ignored, so the file can be
  a shipment's full item list.
- `--first-frame` and `--first-frame-all` still apply to the selected
  items.
- Items not listed are not checked, decoded, reported or fixed, and
  never reach the remap or `--out`.
- Selecting no video item is not an error: the run exits 0.

The summary then says how many video items were selected out of the
manifest's:

```text
posters: 12 of 1504 video items selected: 12 checked, 12 passed (12 by ledger, 0 by pixels), 0 failed, 0 skipped (first frame)
```

`--fix --items FILE` is idempotent like the unrestricted fix.

### Fixing: --fix

`--fix` needs `--remap FILE`. It:

1. Groups the failing items by (video source sha256, `startSeconds`)
   and makes one ship request per pair from the ledger's source ref for
   the video: `{"source": {...}, "kind": "video", "startSeconds": S}`,
   with no `id`, and no `startSeconds` when it is 0.
2. Ships them into `<folder>` through the code `kinetic-media ship`
   runs: the same recipe, tools, reuse cache, merge into
   `<folder>/media-ledger.json`, `--decoder` hooks and limits. Each
   video is reused from the ledger, so only posters are made. Old
   posters stay in `media/` and in the ledger, as ship leaves them.
3. Writes `--remap FILE`, a JSON object of item id -> new poster (a
   manifest `poster` value) for every failing item it fixed, in
   manifest order. `--out FILE` gets the requests it shipped, in ship's
   `--list` format.

It does not edit the manifest: set each remapped item's `poster`, then
run the check again, which exits 0. The run ends `fix: N failing items,
M requests shipped (one per video source and startSeconds), K items
remapped in FILE`.

A failing item it cannot fix is a `NOT FIXABLE <id>: <why>` line: the
ledger has no entry for its video (so names no source to ship), its
source is in project N of a several-project build, the ship skipped the
request (its notes say why), or the file at the source path under
`<game_root>` is not the one the ledger records. The other items are
still fixed and remapped, and the run exits 1.

The requests have no `id`, and ship replaces an identical earlier
request in place, so running `--fix` again on the same manifest finds
the same failures, encodes nothing and leaves the ledger, the media and
the remap byte-identical.

`--fix` ships into `<folder>/media-ledger.json`, so it refuses (exit 2)
a `--ledger` naming any other file; the check alone accepts any ledger.
On a kinetic-extract folder, which has only `build-ledger.json`, the
fix creates `media-ledger.json`. That new ledger does not hold the
folder's transcoded videos yet, so their first fix takes them from the
reuse cache or transcodes them again, to the same bytes.

### The validator's cheap check

`tools/validate_content.py <folder> --ledger FILE` applies the ledger
half of the pass rule without the game, the media tools or any
decoding: it reads the manifest and one ledger with a `media` object
(`build-ledger.json` or `media-ledger.json`) as JSON. It warns on a
video item whose poster's records name only other starts, or the
item's start made from another source, whatever the start. Where the
ledger cannot say (no entry for the poster or the video, or no poster
`startSeconds`) it warns only when the item starts after 0, since a
start-0 item may keep a hand-made first-frame poster. Each warning is a
`warning: ` line on stderr, such as `warning: manifest.json:
items[15].poster: startSeconds 1.0, poster startSeconds 0.0 (poster
made at another start)`, followed by a count. Warnings leave stdout's
problem lines alone, and the exit status too unless `--strict` is given
(exit 3). `kinetic-media posters`
settles what the warning cannot, by pixels, and fixes.

## Reuse cache

Encoding is the slow part of a conversion: lossless JPEG XL at effort 9
on one thread, ffmpeg transcodes, remuxes and posters. `kinetic-extract` and
`kinetic-media ship` keep what they encode in a reuse cache
(`converter/kinetic_extract/media_cache.py`, docs/plan.md Phase 25), so
a re-run, or a later episode shipped into the same folder, encodes
nothing already made from the same bytes, recipe and tools.

- Location: `.tmp/kinetic-media-cache/` at the repo root (gitignored),
  shared by every run from this checkout. `KINETIC_MEDIA_CACHE=DIR`
  puts it elsewhere; `KINETIC_MEDIA_CACHE=off` turns it off. Deleting
  the directory is always safe: the next run encodes again.
- What is remembered: one record per decision. For an image that is the
  whole choice: ext, decision, notes, ledger steps and output sha256,
  so the JPEG XL attempt and the "is it smaller?" comparison are both
  skipped. For a transcode, remux, audio extract or poster it is the
  output sha256. An audio file's decoded duration (keyed by the sha256
  of the file that ships) and a video sound's `volumedetect` maximum
  are remembered as values, so a warm run decodes no audio either.
  Output bytes are stored once by sha256 (`objects/<h[:2]>/<h>`); a
  kept original stores none. A failed transcode, remux, extract,
  poster or decode is not remembered.
- Key: the sha256 of the bytes entering the encode (after any decoder
  hook and carve), the recipe (every step dict and parameter the encode
  can use: PNG and JPEG convert params, JPEG XL effort, the transcode,
  remux, extract, poster, duration and loudness ffmpeg args, the
  poster's start time and PNG params), the run's whole `mediaTools`
  (tool versions and binary sha256s, extractor version), and a cache
  format number that is bumped when the choosing code changes. Any
  difference is a miss.
- Decoder hooks always run, and the ledger's `decode` steps come from
  this run's hooks. The key is the decoded bytes, not the hook's
  identity: a changed hook that decodes differently misses, and one
  that gives the same bytes rightly reuses the encode.
- Integrity: every stored output is hashed when read. A missing, corrupt
  or truncated object is a miss; the corrupt one is deleted and the
  fresh encode stores it again. A record that does not parse is a miss.
  Writes go to a temp file and `os.replace`, so overlapping runs never
  read half a file.
- A warm run gives the same folder as a cold one, byte for byte, ledger
  included (`converter/tests/test_media_cache.py`). It still reads,
  hashes, sniffs and probes every source, and runs the hooks.

Measured on macos-arm64 with the pinned tools (2026-11-02):

| Run | Cold | Warm |
| --- | --- | --- |
| `kinetic-extract fixtures/renpy_demo` | 0.81 s | 0.34 s |
| `kinetic-media ship`, 417-image sample (226 MB) | 300.2 s | 14.6 s |

Both warm folders were `diff -r` identical to the cold ones (the demo's
also to a `KINETIC_MEDIA_CACHE=off` run). The sample's cache held 107 MB
for a 175 MB output folder: only JPEG XL outputs are stored, kept
originals are not. What a warm run still spends is reading, hashing and
sniffing every source.

## Story ID, title and version

Every extraction writes the manifest's `storyId` and `title`
(docs/content-format.md, Manifest; docs/plan.md Phase 21). The `storyId`
comes from `config.save_directory`, else `config.name`, else the project
folder name, slugified; the `title` from `config.name`, else the folder
name with `_`/`-` runs read as spaces. The game's `version` (docs/plan.md
Phase 51) comes from `config.version` when that is a string literal
(plain or `_()`-wrapped, escaped quotes undone, trimmed, cut to 40
characters), such as the `define config.version = "1.0"` of Ren'Py's
`options.rpy` template; an expression, a variable, `None` or a blank
string gives no `version`, and there is no fallback. A slice still reads
all three from `options.rpy`. `--story-id ID`, `--title TEXT` and
`--game-version TEXT` override them (an ID that is not a valid
`storyId`, or a title or version that is blank or too long, is a usage
error), and the run summary prints all three with their sources
(`game version: (none)` when there is none). `--version` prints
Kinetic's own version, not the game's. Keep the `storyId` the same when you
re-extract an updated game, or readers' progress will not follow it.

## Colours and transitions

docs/plan.md Phase 57 item 4: the converter carries the speaker colours
and crossfades Ren'Py draws, into the manifest's `characters` and item
`transition` (docs/content-format.md, "Characters" and "Transitions").
The code is `converter/kinetic_extract/presentation.py`. Text tags
(`{i}`, `{b}`, `{w}` and the rest) stay in the text exactly as written,
neither stripped nor escaped; the player reads them
(docs/content-format.md, "Text tags").

Speaker colours come from a Character however the game makes it:
`define x = Character(...)` (with or without an init priority),
`$ x = Character(...)`, or `x = Character(...)` in an `init python`
block (and `$` lines in `init:` blocks), from `DynamicCharacter`,
`ADVCharacter` and `NVLCharacter` too, the call over one line or
several. The same statements give the speaker's display name
(docs/plan.md Phase 57 item 4c), and a Character with no name argument
takes its `kind=`'s name, through a chain of kinds, as Ren'Py does; a
later statement for the same variable replaces an earlier one. The
colours:

- `color` and `who_color` give the name's colour, `nameColor`;
  `who_color` wins when both are given. `what_color` gives the lines'
  colour, `textColor`.
- Only a string literal is read, in the forms Ren'Py's `Color` reads:
  `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, the `#` optional. It is
  written as `#rrggbb` in lowercase, short forms doubled and any alpha
  dropped. A colour that is an expression or a variable
  (`gui.accent_color`, `"#" + x`) or a string in no such form is left
  out, with a report line.
- `kind=other`, naming another Character define, inherits that define's
  colours, and the define's own colours replace them, as in Ren'Py. Any
  other `kind` (Ren'Py's `adv` or `nvl`, an expression) gives nothing.
- `characters` is keyed by the speaker as the items carry it (the
  display name, or the variable when the name is not a literal), and
  holds only speakers some item in the folder shows, and only those with
  a colour. When several defines give one name, the first defined that
  has a colour wins; a later one with other colours gets a report line,
  `speaker 'Ana' has other colours here than at game/script.rpy:3: the
  first define is kept`. Several projects: the first project's wins.

Transitions come from `with`: a clause ending `scene`, `show` or `hide`
(`scene bg with dissolve`), and the bare statement (`with fade` after
the lines it applies to). Ren'Py applies a `with` to what changed on
screen since the last interaction, and the converter does the same with
the pictures it emits: a clause gives its own statement's item the
transition, and a bare `with` gives it to the picture waiting for its
item when that picture changed since the last line, `pause`, menu or
earlier `with`. When several `scene` and `show` lines come before one
`with`, each still becomes its own item as before, and only the last,
the one the `with` lands on, takes the transition. A `with` after no
picture change (only a sound, a `hide`, which changes no picture the
folder shows, or a solid colour screen) gives nothing.

| Ren'Py | `transition` |
| --- | --- |
| `dissolve` | `{"kind": "dissolve", "seconds": 0.5}` |
| `Dissolve(t)`, `Dissolve(time=t)` | `{"kind": "dissolve", "seconds": t}` |
| `fade` | `{"kind": "fade", "out": 0.5, "hold": 0.0, "in": 0.5}` |
| `Fade(out, hold, in)` | `{"kind": "fade", "out": out, "hold": hold, "in": in}` |
| a name `define`d as one of these | as that |
| `None` and anything else | none: a cut |

- `dissolve` and `fade` are Ren'Py's own definitions
  (`renpy/common/00definitions.rpy`: `Dissolve(0.5)` and
  `Fade(0.5, 0.0, 0.5)`). A game's own `define` of the same name wins,
  as in Ren'Py, and a define may name another define. A `define` is
  read with or without an init priority (`define -2 quick =
  Dissolve(0.2)`), for transitions and Character defines alike.
- A time must be a number literal; `Dissolve(t)` with a variable is a
  cut. Other arguments (`alpha=`, `time_warp=`) are ignored.
- A time above 5 seconds is clamped to 5, and a `Fade` time below 0 to
  0, each with a report line. `Dissolve(0)`, or a `Fade` whose `out`
  and `in` are both 0, is a cut.
- `Fade`'s `color` is not carried: the fade goes through black. A colour
  other than black gets a report line and the fade is kept.
- Every other transition is a cut: `with None`, Ren'Py's `pixellate`,
  the `move`, `wipe`, `slide`, `push`, `iris` and `zoom` families, `hpunch` and `vpunch`, `ImageDissolve`, `Pixellate(...)`,
  `MoveTransition(...)`, a dict of layer transitions, and a name
  `define`d as any of those.

A note about how a transition was read (a clamped time, a fade's
colour) is one report line, at its first use, counting the uses:
`transition: Dissolve time 8 s clamped to 5 s (2 uses; this is the
first)`. The run summary prints two lines after the branches:

```text
speaker colours: 5 of 7 speakers
transitions: kept dissolve 40, fade 6; with no picture change 9; cut: None x31, hpunch x4, pixellate x1
```

`kept` counts the transitions on the folder's items by kind; `with no
picture change` the `with` statements read as a dissolve or fade that
landed on no item the folder shows (including an item the asset pass
dropped); `cut` every cut met in the walk, by the name written (a call
by its function's name, a define by its own name). The ledger's
`transitions` holds the same counts: `kept` (kind to count),
`noPictureChange` and `cut` (name to count).

## Translations

A Ren'Py project may ship translations under `game/tl/<language>/`
(Ren'Py's "Generate Translations"), as loose files or inside its `.rpa`
archives. kinetic-extract reads them by default (docs/plan.md Phase 56
items 9 and 9b) and writes one language file per language, `lang/<tag>.json` and its `lang/<tag>.js`, in the format of
docs/content-format.md, "Translations"; `--no-translations` leaves them
out. The code is `converter/kinetic_extract/translations.py`.

What is read, per language:

- **Dialogue blocks**, `translate <language> <identifier>:`. Each is
  matched to the item made from the same say statement by Ren'Py's own
  translation identifier, which kinetic-extract computes from the game's
  `.rpy` sources (the `.rpy` scripts the walk reads, with the run's
  `--files`: Slice support, "Which scripts are walked", above; in
  Ren'Py's load order) as Ren'Py does (`renpy/translation/__init__.py`
  and `Say.get_code()` in `renpy/ast.py`): the enclosing label (`.` as
  `_`), `_`, and the first 8 hex digits of the MD5 of the say
  statement's code in Ren'Py's canonical form (speaker, attributes,
  `@` attributes, the text re-quoted after Ren'Py's own string reading,
  `nointeract`, `id`, arguments, `with`), each statement's code followed
  by `\r\n`, the `voice`, `voice sustain` and `nvl clear` statements just
  before it included. A repeated identifier gets `_1`, `_2`, ... across
  the label and the files loaded before; a label starting with `_`, a
  hidden label, a local `.label`, a named `menu` and an explicit
  `id` clause count as in Ren'Py; say statements inside `if`, `while`,
  `menu` and `init` blocks count, those in `python`, `screen` and
  similar blocks do not. A block's say statements give the item's text,
  read with the converter's own string reading, so text tags and
  `[interpolation]` stay as the manifest has them; a block with several
  (a translator's split) joins them with a space, an `extend` line
  continuing the line before as written. A block of `pass` (or without a
  say statement) gives no translation.
- **`extend` lines.** Ren'Py shows an `extend "..."` line as the line
  before it with the text added, as written, in one box with the same
  speaker (`_Extend` in `renpy/common/00library.rpy`; the `{fast}` it
  puts between them only shows the earlier part at once). The walk does
  the same: the extension joins the item of the say statement before it,
  by direct concatenation, and that item's text is all of its parts. An
  `extend` with no line before it in the walk (at the start, or as the
  first line of a menu's choice, since a route's line never continues
  the lead-in's) is narration; a game that defines its own `extend`
  character keeps it as a speaker. A `voice` statement just before an
  `extend` line is reported and not converted (the item keeps its own
  voice). Each `extend` line has its own identifier and dialogue block in
  `tl/`; the item's translation joins its parts' translations the same
  way, and an item with a part untranslated gets none (counted as
  "extended lines missing a part").
- **The location comment** Ren'Py writes above each block,
  `# game/script.rpy:LINE`, names the line of the block's first
  statement when the file was generated. The report counts whether it
  names the identifier's line (agree) or another (disagree: it goes stale
  as the script is edited; a converted corpus game, below, has stale
  comments on about half its blocks). When the identifier names no
  statement, the comment is the fallback, taken only when the statement
  on that line is the one Ren'Py commented inside the block (`    #
  e "Hello."`), so a stale comment never gives a line another line's
  translation.
- **Changed English kept as stale.** A block whose identifier names no
  statement because the English changed since the translation was made
  is kept when the line its comment names is safely the same line: the
  statements Ren'Py commented inside the block hash to the block's
  identifier (so they are the code it was made from), the identifier's
  label is the label of the statement on that line now, and the old and
  new say statements have the same speaker. Its translation is written
  with `from` the hash of the old English (the commented say statement
  read as the converter reads say text), so the validator and
  `tools/translations.py status` report it stale and a translator can
  update it. A block for the current English of the same line wins over
  a stale one, wherever each sits. Anything less certain stays unmatched.
- **String blocks**, `translate <language> strings:`, `old`/`new`
  pairs: a menu's choices become its route labels, its caption the
  decision's prompt (a prompt the converter supplied, "What happens
  next?", has none), the speakers' names (the manifest's `speaker`, the
  `Character` name) their translations, and the manifest's `title` and
  `version` theirs, each matched with runs of spaces read as one. A
  translated prompt of 200 characters or more, a label of 120 or more, a
  title over 200 or a version over 40 is skipped with a warning; an
  empty `new` is no translation.
- **Speakers' names.** A `define x = Character(...)` (or
  `DynamicCharacter(...)`) gives the speaker's display name from its
  first positional argument or `name=`, a string literal, plain or
  wrapped in Ren'Py's translation markers: `Character("Ana")`,
  `Character(_("Ana"))`, `Character(__("Ana"))`,
  `Character(name=_("Ana"))`. The wrapped name is the text a `strings`
  block translates, so its translation becomes the language file's
  speaker name. A call written over several lines is read whole. A
  dynamic character, `DynamicCharacter("var")` or `Character("var",
  dynamic=True)`, names a variable whose value Ren'Py shows: its name
  reads `[var]`, as `Character("[var]")` does. A name that is only an
  interpolation, `[var]`, is kept literal like any interpolation, and no
  `strings` block translates it (Ren'Py shows the variable's value). An
  expression starting with such a literal, `Character("Ana" + x)` or
  `Character(_("Ana") + x)`, gives the literal, `Ana`, as before item
  9b. A name the converter cannot read (any other expression, `None`)
  leaves the speaker as the variable's name, as before.
- **Ignored and counted**: `translate <language> style` blocks (fonts:
  Kinetic draws with system fonts), `translate <language> python`
  blocks, and every other file under `tl/<language>/` (Ren'Py's
  per-language file replacements, such as images: pictures are the same
  in every language). A compiled `.rpyc` with no `.rpy` beside it (loose
  or in an archive) is not read, and counted. The replacements are never story flow or image
  names: `tl/` is left out of the script walk, whatever `--files` says,
  and out of the implicit image index.

Each translated string records `from`, the hash of the manifest's base
text (or of the old English, for a block kept as stale), so the
validator can tell a stale one. The manifest gains `languages`, the
tags of the language files written, sorted. Its `language` stays absent
(English), since a Ren'Py project does not say which language its
script is in, unless `--base-language TAG` names it: a game written in
Japanese that ships `tl/english` converts with `--base-language ja`,
the manifest says `"language": "ja"`, a `tl/` language whose tag is
`ja` (`tl/japanese`, an older copy of the script) is skipped with a
warning, and `tl/english` (or `tl/en`) becomes `lang/en.json` like any
other language. TAG is a BCP 47 tag, written in canonical casing
(`--base-language PT-br` gives `pt-BR`); a malformed one is a usage
error. When the game has `voice` statements
the converter turned into recorded voice lines, every language file
says `"keepOriginalVoice": true`, as Ren'Py plays the original voice
under a translation. A language with no translated string gets no file.
The files are written before the schema copy, so the folder gets
`lang.schema.json` and each file opens with `"$schema":
"../lang.schema.json"`.

### Language names and tags

A language is known by its Ren'Py name, the name in its `translate`
statements (by convention the `tl/` folder's name), mapped to a
canonical BCP 47 tag:

| Ren'Py name | Tag |
| --- | --- |
| a code, `de`, `fr`, `ja`, `ko`, `ru`, `pl`, `tr`, `it`, `es`, ... | itself |
| a code and region, `ptBR`, `ptPT`, `pt_BR`, `zh-TW` | `pt-BR`, `pt-PT`, `pt-BR`, `zh-Hant` |
| `zh`, `zhCN`, `zhSG`, `chinese`, `schinese`, `SimplifiedChinese` | `zh-Hans` |
| `zhTW`, `zhHK`, `tchinese`, `TraditionalChinese` | `zh-Hant` |
| `esLT`, `esLA`, `latam`, `SpanishLatinAmerican` | `es-419` |
| `brazilian`, `PortugueseBrazil` | `pt-BR` |
| `english`, `french`, `german`, `spanish`, `russian`, `japanese`, `korean`, `italian`, `polish`, `turkish`, `portuguese`, `ukrainian`, `czech`, `dutch`, `indonesian`, `vietnamese`, `thai`, `arabic`, `hebrew`, `greek`, `hungarian`, ... | `en`, `fr`, `de`, `es`, `ru`, `ja`, `ko`, `it`, `pl`, `tr`, `pt`, `uk`, `cs`, `nl`, `id`, `vi`, `th`, `ar`, `he`, `el`, `hu`, ... |

Names are matched without regard to case, and long names written
together (`SpanishSpain`, `chinese_simplified`) as one word. A code is
accepted only for a known ISO 639 language, so a typo is not taken for a
tag. The whole table is `LANGUAGE_NAMES`, `SQUASHED_NAMES` and
`KNOWN_LANGUAGES` in the module. `None`, Ren'Py's untranslated
placeholder, and `__pycache__` (Python's cache, found in some archives)
are skipped silently. An unknown name is skipped with a
warning naming it and `--language-map NAME=TAG` (repeatable), which
gives its tag and also overrides the table (`--language-map
klingon=tlh`, `--language-map zhCN=zh-Hant`); a malformed TAG is a usage
error. A name whose tag is the base language (`english`, or the
`--base-language` tag) is skipped with a warning. When several names give one tag (an older translation
named `German` left beside the current `de`), the one a `tl/` folder is
named after wins, then the one with more dialogue blocks, and the rest
are skipped with a warning.

### The report

The run summary gains, after the sound's lines, the warnings and then a
line per language file written and per language skipped, and per
language: its dialogue blocks matched to items (and of those, through
the comment alone), those kept as stale, those for lines the walk made
no item of (inside a skipped block, a dropped item, a file the walk did
not read), `pass` or empty, and unmatched (with up to five by
`file:line` and identifier); the identifier and comment agreements and
disagreements (up to five examples); the strings used of those read;
the blocks of several lines joined, duplicates, translations equal to
the base text and, when there are any, items of `extend` lines with a
part untranslated; the coverage in the words `tools/translations.py
status` uses (its stale count the translations kept as stale); and the
ignored style blocks, python blocks and replacement files:

```text
translations: 2 language file(s) written (de, zh-Hans); skipped: klingon (unknown name)
  de (tl/de): dialogue blocks 13: matched to items 9 (by comment only 1), kept as stale 0, lines not in the story 2, pass or empty 1, unmatched 1; identifier and comment: agree 11, disagree 0, no comment 0
    strings used 4 of 5; several lines joined 1, duplicates 0, same as the base text 0; coverage de: 12 of 28 strings (42.8%), 0 stale, 0 unchecked; ignored: style blocks 1, python blocks 1, replacement files 1
    unmatched: game/tl/de/script.rpy:77 (inside_deadbeef)
```

The ledger's `translations` holds the same counts per tag
(`languages`) and the names skipped (`skipped`).

Not read: compiled-only `tl/` scripts, the lines of compiled-only game
scripts (no identifiers are computed from a `.rpyc`), and translations
of statements the converter itself does not make items of. Run
`.venv/bin/python tools/translations.py status <folder>` for each
language's coverage afterwards, and `export` to hand a language's
missing lines to a translator (docs/translating.md).

### Real check

A converted corpus game ships `tl/` folders for 14 languages (and
`None`), and in them blocks under 12 more names: a lowercase twin,
`eslt`, and 11 older names (`German`, `SpanishSpain`, ...). Read
without its media (the parsing and matching layer called directly, the
walk given every script under `game/`), each of its 14 current languages
(`de`, `es`, `esLT`, `fr`, `it`, `ja`, `ko`, `pl`, `ptBR`, `ptPT`, `ru`,
`tr`, `zhCN`, `zhTW`) has 4,316 dialogue blocks (4,318 for `zhCN`), and:

- identifiers name a statement for 4,314 (99.95%); the other two
  translate lines whose English has changed since, and are left out
  (their comments point at other statements now);
- the comment names the identifier's line for 1,450 blocks, another
  statement's line for 1,694 and no statement's first line for 1,170:
  the script was edited after the files were generated (1 to 62 lines
  off);
- the walk made 641 text items, and the 571 that are dialogue are
  translated in every one of the 14 languages (88.5% of the 645 strings
  the validator would count, the rest being 70 strings of code the walk
  took for lines and the 4 speakers);
- 3,978 of the 4,316 computed identifiers also name the game's own voice
  files, which its `config.auto_voice` names by the same identifier.

`eslt` and 10 of the older names were skipped as duplicates of current
languages; `SpanishSpain` (59 old blocks, 33 matched) became `es-ES`.
No menu strings were used: the game's menus are not detected as
decisions.

Read again with item 9b's changes (2026-11-17), the same way:

- its two `_()`-wrapped `Character` names (`define a =
  Character(_("..."))`) are now the speakers of their 15 lines, and the
  `strings` blocks translate both in each of the 14 current languages
  (in five of them into another script). The other two speakers, 530
  lines, are `Character("[var]")` interpolations, kept literal and not
  translated. Coverage is now 573 of the 645 strings (88.8%) in each
  current language;
- of the two blocks per language whose English changed, one passes the
  stale checks, but every language also has a block for that line's new
  English, which wins; the other's comment names a line spoken by
  another speaker now, so it stays unmatched. None is kept as stale;
- the game has no `extend` lines.

Translations inside archives (read-only, 2026-11-17): 41 of the corpus's
`.rpa` archives hold `tl/` members. In one corpus game whose
scripts and eight languages are all inside one archive, each language's
23,195 to 24,405 dialogue blocks and about 1,040 strings are read, and
the identifiers computed from the 68 archived scripts name a statement
for 19,284 blocks in seven languages (18,360 in the eighth); the rest
name no statement of these scripts (not examined further). Its
`tl/__pycache__` is skipped. In
another, every `tl/` block translates Ren'Py's template script, not the
game's, so none names a statement, as expected.

## Media tools

Since docs/plan.md Phase 25 every extraction runs with the pinned media
tools: run `.venv/bin/python tools/setup_media_tools.py` once per
checkout before extracting, and `kinetic-extract` refuses to start
until its golden-hash self-test passes (converter/README.md, "Pinned
media tools"). Lossless JPEG XL now comes from libjxl inside imagecodecs
instead of a system `cjxl`. The Results below predate this: they ran
with the system ffmpeg 6.1.1 and `cjxl` 0.10.2, so their shipped bytes
are not the pinned tools' bytes.

## Results

One subsection per sampled game. The first pass ran five slices
(2026-10-31) and recorded five extractor bugs; the same five slices were
then re-extracted with the fixes in (same commands, same slice
parameters, output under `.tmp/slice2-*`) and their entries below carry
the new numbers, marked FIXED. Game D keeps its earlier smoke note (not
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
  game A's and game B's loose `images/` files (names with spaces
  included) and game E's archive members. A patch overlay whose assets
  live in another package (the game C entry) still answers nothing — cross-dir lookup is out of
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
- BUG 3 FIXED — the speaker regex accepts the no-space `al"..."` /
  `bo"..."` form; those lines are dialogue now, not "unrecognized
  statements".
- BUG 4 FIXED — a `game` dir reached through a symlink parses: ledger
  rels are computed against the `game` dir itself (the old
  `twin.resolve().relative_to(project_root.resolve())` at parser.py
  raised `ValueError` there), with `os.path.realpath` on both sides as
  the fallback. The game C run below re-ran through a corpus symlink
  with the same clean result.

### Image policy sample (Phase 25 item 25.5)

Done (2026-11-02). The converter's own image decision
(`assets.decide_image_ship`, the 25.5 policy, pinned Pillow 13.0.0 and
imagecodecs 2026.10.10 / libjxl 0.12.0, effort 9, one thread) ran over
417 images copied from the corpus into `.tmp/25.5/sample/`: every Nth
file in sorted order, gui folders left out. Game D supplied 200 of
its 1441 `.webp` (WebP-heavy: 1440 of the 1441 are lossy VP8, none
animated, 4 with alpha), game B 60 of 481 `.png` and all 37 `.jpg`,
game A 60 of 1006 `.jpg`, game E 60 of the 13 436 images in
`images.rpa`.

| Source format | Images | JXL shipped | Before | After | Saved |
| --- | --- | --- | --- | --- | --- |
| JPEG (recompression) | 149 | 149 | 93.84 MB | 72.03 MB | 23.2 % |
| PNG (lossless pixels) | 66 | 66 | 70.29 MB | 37.80 MB | 46.2 % |
| WebP, lossy (lossless pixels) | 202 | 0 | 71.92 MB | 71.92 MB | 0 % |
| All | 417 | 215 | 236.05 MB | 181.75 MB | 23.0 % |

Per game: game B PNG 46.3 %, JPEG 14.4 %; game A JPEG 23.0 %; game E
JPEG 25.4 %, PNG 43.1 %; game D 0 %.

Fallbacks, all 202 of them lossy WebP kept because the exact JXL was
bigger: the lossless JXL of a lossy WebP's decoded pixels is 2.0 to 6.7
times the WebP (median 4.6). The four `.tmp/f-slice` WebPs
(game F) went the same way (2.5 to 2.6 times). Every
JPEG's recompression rebuilt the original bytes exactly, so none fell
back. No lossless WebP turned up in the corpus; the lossless route is
covered by the converter tests.

ICC profiles: 147 sampled images embed one (101 JPEG, 43 PNG, 3 WebP),
all sRGB (`GIMP built-in sRGB` in game B's PNGs, `sRGB
IEC61966-2.1` in the JPEGs) except one Adobe RGB JPEG. A JPEG keeps its
profile through recompression. For the pixel route the converter
converts the image's own pixels from the profile to sRGB, and when
nothing changes (true for all 46 PNG/WebP here) it drops the profile and
records `iccProfile` on the `jxl` step. A first run that kept every
profile-carrying original saved 21.6 % on PNG instead of 46.2 %.

Cost: the lossy-WebP attempts are the expensive part, about 27 s per
2560x1440 image single-threaded, 5452 s of CPU for 202 images that all
fell back, against 31 s for the 149 JPEGs. A full game D run would spend
about 11 hours trying JXL on its 1441 lossy WebPs before keeping them
all. Item 25.5b therefore stops trying lossy WebP: it ships unchanged
with no decode, reason `lossy WebP: exact JPEG XL is always larger`.

### Game A: `.app` with `.rpy` sources

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/…/<game A>.app .tmp/slice2-a --files
script.rpy --label <a video stretch's label> --max-items 6` →
exit 0: 6 items (video 6), 6 media shipped, resolution 1280x720
(default — the shipped surfaces are all videos, nothing measured as an
image). Validator exit 0. Play: all 6 video surfaces decoded, 0 overlay
lines (this stretch carries no dialogue), console clean, exit 0.

This entry now proves BUG 2 end to end: the six sliced scenes are
exactly `image NAME = Movie(play="NAME.webm")` definitions — the ids
come out clean (`beach-00686-001`, not `beach 00686 = Movie(play…`),
each item is a VIDEO item with the game's own
`images/beach 00686.webm` (spaces in the names are no problem), its
ffprobe duration, and a poster. Ledger for the run: 52 unrecognized
statements (down from 1854 — BUG 3 turns the `al"..."`/`bo"..."` lines
into dialogue), 42 unsupported (`stop music`, `play music "…"`), 9
`hide` skipped, 3 `menu unsupported`; no `image not defined` and no
`droppedUnresolved` entries remain — BUG 5's index answers the other
scene names from the loose `images/` dir.

Control run re-run: `--files screens.rpy --max-items 6` → exit 0, 0
items, validator exit 0 (the empty `items` array is valid), and
play-folder reports `items: 0` with `errors: []` — the "all scenes
dynamic" case is a clean empty pass now, the player showing its
no-content notice (BUG 1 + schema), not a validator failure.

### Game B: `.app` with numbered `.rpy` story files

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/…/<game B>.app .tmp/slice2-b --files
<part>0.rpy --label start --max-items 6` →
exit 0: 6 items (image 6, two carrying their first dialogue line), 4
media shipped (three `scene bg black` refs deduped onto one file),
resolution 1920x1080 (most common source image size — real pixels now,
not the default). Validator exit 0. Play: 4 of 4 distinct images
painted (`naturalWidth` 1920), 3 overlay lines, console clean, exit 0.

This is BUG 5's home turf: the game has no `image` statement at all,
and `show title1`/`scene bg black` now resolve through the implicit
index to `images/title1.png`/`images/bg black.png` — the name-is-the-
file-stem case is exactly the path-with-directory/basename key lookup,
and three of the six shipped as lossless JXL (smaller, verified).
Stale twins behaved as designed: ledger `rpycIgnoredTwins` records
`game/<part>0.rpyc` with `game/<part>0.rpy` kept. Ledger for the
run: 33 `menu unsupported` (this game branches a lot), 22 unrecognized
statements (`if cond == True:` and `else:` block heads), `jump` follow
notes. The first pass also turned `show screen hud` into a visual
(`screen-hud-001`); a `show screen` should still be reported and
skipped the way `show layer` is — an open follow-up, not re-run here.

### Game C: a patch overlay (a1)

Done (2026-10-31, bug-fix re-run; supersedes the first pass). Same
scratch copy as the first pass (the patch dir holds four
`.rpy`/`.rpyc` pairs and no `game/` directory):
`cp -R "<corpus>/…/<game C patch>/a1" .tmp/c-src/game`, then
`kinetic-extract .tmp/c-src .tmp/slice2-c --files <script>.rpy --label
<label> --max-items 6` → exit 0:
0 items, 0 media shipped. Validator exit 0. Play: `items: 0`,
`errors: []`, exit 0 — the player's no-content state, clean.

An honest empty, stated plainly: the patch's assets all live in the
main `.app` (its `game/images/a1/<place>/…`), the converter
resolves inside the input `game/` directory only, so no visual in the
sliced flow answers anything and the ledger carries 409
`droppedUnresolved` notes. BUG 1 drops each such item, and its
dialogue lines with it — a `text` item needs a visual — so the first
pass's "6 overlay lines over one placeholder image" became this empty
folder rather than a validator failure; the patch's own three defs are
`image <name> = Movie(play="/images/a1/<place>/<folder>/<name>.webm",
pos=…, anchor=…)` lines, which BUG 2 now registers
under clean keys, but their project-rooted play paths name no file the
patch directory contains. Cross-package (overlay → main game) asset
resolution would be new scope; it stays recorded here as the reason
this entry is empty, not playable content.

BUG 4 re-check, no copy needed any more: `ln -s "<corpus>/…/a1"
.tmp/c-link/game; kinetic-extract .tmp/c-link .tmp/slice2-c-link
--files <script>.rpy --label <label> --max-items 6` → exit 0,
same ledger shape. The old `parser.py` `ValueError` for a symlinked
`game` dir is gone; the corpus was not written to either way. Ledger
for the run otherwise as before: 38 unrecognized, 16 unsupported,
9 `menu unsupported`, two `jump`s followed linearly, one cross-file
`call`.

### Game D: compiled-only `.app`

Done (2026-10-31, unrpyc item smoke). 12 `.rpyc` decompiled via the
vendored unrpyc (no `.rpy` present). `--max-items 8` yields 8 items
(5 image, 3 text), 0 media shipped: scene names are dynamic refs with no
`image` defs, so assets are unresolved. Skips logged are unrecognized
`play/stop sound|music` (925 total), unsupported statements (214), `menu`
(7), image-not-defined (5). Sources recorded in ledger `rpycSources`.

(2026-10-31: not re-run this round — its zero-media outcome is exactly
the BUG 1/5 pair now fixed, and the decompiled-script path with implicit
resolution against a loose `images/` dir is covered by the CLI test in
`converter/tests/test_rpyc.py` on the checked-in `credits.rpyc`.)

### Game E: archive-only `.app`

Done (2026-10-31, bug-fix re-run; supersedes the first pass).
`kinetic-extract <corpus>/<game E>.app .tmp/slice2-e --files
scripts/<part>.rpyc --max-items 6` → exit 0: 6 items (image 2, text
4), 2 media shipped, resolution 1920x1080 (most common source image
size). Validator exit 0. Play: both images painted (`naturalWidth`
1920), all 6 overlay lines, console clean, exit 0.

The binding the first pass found missing is now made the way Ren'Py
makes it: `scene street night 1` has no `image` definition anywhere
(that stays true — the name is built at runtime), and BUG 5's index
answers it from `images.rpa`. The ledger assets read
`rpa!images/EP2/street night 1.jpg` / `… night 2.jpg`, the members
extracted through the usual cache and shipped by the normal asset pass
with their `rpa` provenance notes. `--files` is still what keeps a
slice of this game small: `script_entries` finds 1494 script members,
all `.rpyc`, and the script came out of the archive (ledger
`rpaScriptSources`: `game/scripts.rpa!scripts/<part>.rpyc`). Ledger
for the run keeps its shape: 67 unrecognized statements (mostly
`play music <track> if_changed …`), two cross-file `call target`
notes, 2 `menu unsupported`; no `image not defined` left.

### Game F: `.zip` release

Done (2026-10-31, bug-fix re-run from the same scratch dir; supersedes
the first pass — the unpacking itself, 9 of 9332 entries, stands).
`kinetic-extract .tmp/f-slice .tmp/slice2-f --files script.rpy
--label kinetic_slice_pose07 --max-items 4` → exit 0: 4 items (image 2,
text 2), 2 media shipped, resolution 1280x720 (most common source image
size). Validator exit 0. Play: 2 of 2 images painted (`naturalWidth`
1280), all 4 overlay lines, console clean, exit 0.

The four items changed shape, not health: BUG 3 makes the `al"..."`
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
first pass's two definition-less placeholder items
are dropped now (BUG 1), the 15 096 unrecognized statements were mostly
the no-space dialogue style and are gone (96 remain), the 195
`hide skipped` stand.

Two facts from the first pass still hold and cost no re-run: the file
has 197 labels all before line 2061 (the story is one ~36 000-line
`label start`, first defined visual at line 3837), so `--label` is the
only way in — the slice start was pinned by inserting
`label kinetic_slice_pose07:` at that line in the scratch copy, corpus
untouched.
