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

## Several episodes, one game

A game released as several Ren'Py projects (episodes) becomes one
Kinetic game (docs/plan.md Phase 25): list the projects in story order,
then the output folder.

```sh
.venv/bin/kinetic-extract <episode1> <episode2> [...] <out> \
    [--decoder MODULE:FUNC ...] [--story-id ID] [--title TEXT]
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
- `storyId` and `title` come from the first project unless
  `--story-id`/`--title` are given; the summary notes when the projects
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

## Build ledger

`build-ledger.json` sits beside the manifest; the player and validator
ignore it. Besides the walk's record (`inputs`, `items`, `report`,
`branchDetection`, the `rpyc*`/`rpa*` source lists, `slice`), it holds
enough to make every shipped media file again from the original game
files (docs/plan.md Phase 25), which `kinetic-media rebuild` reads:

- `mediaTools`: the tools this run used. `ffmpeg` and `ffprobe` as
  `{version, sha256}` (the version `-version` reports and the binary's
  hash), `Pillow`, `imagecodecs`, `libjxl`, `numpy`, `kinetic-extract`,
  and `pinned` (false only under the test-only `KINETIC_MEDIA_TOOLS_DIR`
  override, whose output is not reproducible).
- `media`: one entry per shipped file, keyed by its path
  (`media/<h[:2]>/<h>.<ext>`), posters included:
  - `kind`: `image`, `video` or `poster`; `sha256` and `bytes` of the
    shipped file.
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
      a copied video's `codec` is its ffprobe video codec name (Video
      policy, below);
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
      `reason` why the source container or tag could not ship;
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
  - `alsoFrom`: other sources that made the same bytes, each with its own
    `source`, `steps` and `tools`; `source` is the first in item order.

- `decoders`: present when the run had `--decoder` hooks: each as
  `{"hook", "hookSha256"}`, in the order given, so a rebuild can require
  the same hooks with the same code.

Each item entry names its outputs with `file` and `poster` (keys into
`media`), its `asset` as a display string (`game/images/a.png`, or
`game/images.rpa!images/a.png` for an archive member), plus
`sniffedFormat`, `decision` and, for video, `codec`. Every dict in
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
because the player plays videos muted, and one recipe with no
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
  media source the asset pass reads (images and videos), loose file or
  `.rpa` member, with the source's COMPLETE bytes (a wrapper's layout may
  depend on the file length), before format detection and carving.
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
game I included (its episodes 4-5 use an activation-dependent
offset), and that game's real hook lives in its own conversion
package.

## kinetic-media ship

A game-specific helper that builds the story itself can hand all media
work to Kinetic without a story parse (docs/plan.md Phase 25; a worked
example is in CREATE.md, "Writing your own converter: kinetic-media
ship"):

```sh
.venv/bin/kinetic-media ship <game_root> <out> --list requests.json \
    [--decoder MODULE:FUNC ...] [--jobs N] [--video-jobs N]
```

Each request goes through the same asset pass as kinetic-extract: the
decoder hooks, the Image and Video policies, posters, and
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
  {"source": {"path": "areas/intro.webm"}, "kind": "video",
   "startSeconds": 2.5}
]
```

- `source`: `{"path"}` for a loose file, or `{"archive", "member"}` for
  an `.rpa` member (the archive path, and the member key exactly as the
  archive stores it).
- `kind`: `"image"` or `"video"`.
- `startSeconds` (videos only, a number >= 0): the poster is the frame
  at that time. The default is 0.
- `id` (optional, a non-empty string): the helper's own key. It must be
  unique within one list.

A malformed list is refused before any work. The run exits 2 and
names each bad entry by its position, e.g. `request 2: kind must be
"image" or "video", got 'audio'`.

`<out>/media-ledger.json` holds `generatedBy`, then `mediaTools`,
`decoders` and `media` exactly as in the build ledger (Build ledger,
above), then `requests`. Each request is echoed as given, with paths
normalized, and paired with its result:

```json
{"request": {"kind": "video", "source": {"path": "areas/intro.webm"},
             "startSeconds": 2.5},
 "result": {"codec": "vp9", "decision": "copy", "durationSeconds": 12.0,
            "file": "media/3f/3f…e1.webm", "height": 720,
            "notes": [], "poster": "media/9a/9a…07.jxl",
            "sniffedFormat": "webm", "width": 1280}}
```

- `file`, plus `poster` and `durationSeconds` for a video: the values
  for the manifest item.
- `width`/`height`: the display size, read from the shipped image or
  from the poster frame.
- `decision`, `sniffedFormat`, `codec`, `notes` and `warning`: as in a
  build-ledger item entry.
- A request with no `file` was skipped. Its `decision` is
  `missing-source` (no such file, `archive not found`, `member not in
  archive`) or `skipped` (not a usable image or video, or a failed
  poster), and its notes say why. The helper drops that item.

Exit codes:

- 0: every request ran. Skipped requests do not fail the run; the
  summary line `requests: N; shipped: M; skipped: K` lists each one
  with its reason.
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
  folder.
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
- `--video-jobs N`: of those, at most N transcodes or remuxes (default:
  a quarter of `--jobs`, at least 1). A waiting transcode takes the
  next free slot before any waiting still image, so long transcodes
  start early instead of last.

The folder is the same whatever the limits: the same files, the same
bytes, and a byte-identical `media-ledger.json`. How `ship` keeps it
so (`converter/kinetic_extract/workers.py`, `assets._plan_ahead`):

- First one coordinator walks the requests in order. It reads and
  hashes each source, runs the decoder hooks, sniffs images and probes
  videos (each file once), and queues every encode the requests need:
  an image decision, a poster, a transcode or a remux. Each is keyed
  by what it encodes (the input's sha256, plus `startSeconds` for a
  poster), so an encode many requests share is queued once. An output
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

The pinned tools' self-test runs first. The ledger's `mediaTools` must
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
   so recipe and code cannot drift. The decoder hooks run first, as in
   the asset pass, and the `decode` steps they make must equal the
   recorded ones.
3. Check the output's sha256 against the entry's.

The folder's `media/` is then checked against all entries. It is
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
  skipped. For a transcode, remux or poster it is the output sha256.
  Output bytes are stored once by sha256 (`objects/<h[:2]>/<h>`); a
  kept original stores none. A failed transcode, remux or poster is not
  remembered.
- Key: the sha256 of the bytes entering the encode (after any decoder
  hook and carve), the recipe (every step dict and parameter the encode
  can use: PNG and JPEG convert params, JPEG XL effort, the transcode,
  remux and poster ffmpeg args, the poster's start time and PNG params), the
  run's whole `mediaTools` (tool versions and binary sha256s, extractor
  version), and a cache format number that is bumped when the choosing
  code changes. Any difference is a miss.
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

## Story ID and title

Every extraction writes the manifest's `storyId` and `title`
(docs/content-format.md, Manifest; docs/plan.md Phase 21). The `storyId`
comes from `config.save_directory`, else `config.name`, else the project
folder name, slugified; the `title` from `config.name`, else the folder
name with `_`/`-` runs read as spaces. A slice still reads both from
`options.rpy`. `--story-id ID` and `--title TEXT` override them (an ID
that is not a valid `storyId` is a usage error), and the run summary
prints both with their sources. Keep the `storyId` the same when you
re-extract an updated game, or readers' progress will not follow it.

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

### Image policy sample (Phase 25 item 25.5)

Done (2026-11-02). The converter's own image decision
(`assets.decide_image_ship`, the 25.5 policy, pinned Pillow 13.0.0 and
imagecodecs 2026.10.10 / libjxl 0.12.0, effort 9, one thread) ran over
417 images copied from the corpus into `.tmp/25.5/sample/`: every Nth
file in sorted order, gui folders left out. game-d.app supplied 200 of
its 1441 `.webp` (WebP-heavy: 1440 of the 1441 are lossy VP8, none
animated, 4 with alpha), game-b.app 60 of 481 `.png` and all
37 `.jpg`, game-a.app 60 of 1006 `.jpg`, game-e.app
60 of the 13 436 images in `images.rpa`.

| Source format | Images | JXL shipped | Before | After | Saved |
| --- | --- | --- | --- | --- | --- |
| JPEG (recompression) | 149 | 149 | 93.84 MB | 72.03 MB | 23.2 % |
| PNG (lossless pixels) | 66 | 66 | 70.29 MB | 37.80 MB | 46.2 % |
| WebP, lossy (lossless pixels) | 202 | 0 | 71.92 MB | 71.92 MB | 0 % |
| All | 417 | 215 | 236.05 MB | 181.75 MB | 23.0 % |

Per game: game-b PNG 46.3 %, JPEG 14.4 %; game-a
JPEG 23.0 %; game-e JPEG 25.4 %, PNG 43.1 %; game-d 0 %.

Fallbacks, all 202 of them lossy WebP kept because the exact JXL was
bigger: the lossless JXL of a lossy WebP's decoded pixels is 2.0 to 6.7
times the WebP (median 4.6). The four `.tmp/f-slice` WebPs
(game-f) went the same way (2.5 to 2.6 times). Every
JPEG's recompression rebuilt the original bytes exactly, so none fell
back. No lossless WebP turned up in the corpus; the lossless route is
covered by the converter tests.

ICC profiles: 147 sampled images embed one (101 JPEG, 43 PNG, 3 WebP),
all sRGB (`GIMP built-in sRGB` in game-b's PNGs, `sRGB
IEC61966-2.1` in the JPEGs) except one Adobe RGB JPEG. A JPEG keeps its
profile through recompression. For the pixel route the converter
converts the image's own pixels from the profile to sRGB, and when
nothing changes (true for all 46 PNG/WebP here) it drops the profile and
records `iccProfile` on the `jxl` step. A first run that kept every
profile-carrying original saved 21.6 % on PNG instead of 46.2 %.

Cost: the lossy-WebP attempts are the expensive part, about 27 s per
2560x1440 image single-threaded, 5452 s of CPU for 202 images that all
fell back, against 31 s for the 149 JPEGs. A full game-d run would spend
about 11 hours trying JXL on its 1441 lossy WebPs before keeping them
all. Item 25.5b therefore stops trying lossy WebP: it ships unchanged
with no decode, reason `lossy WebP: exact JPEG XL is always larger`.

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
