# kinetic-extract

Ren'Py extractor (docs/plan.md Phase 10 onwards): reads a Ren'Py
project's `game/*.rpy` sources (decompiling `.rpyc` when no `.rpy`
exists, reading `.rpa` archives) with a statement-subset parser and
writes a playable Kinetic content folder: `manifest.json`,
`manifest.js`, `manifest.schema.json` (a copy of
docs/content-schema.json for editors, named by the manifest's
`$schema`), `build-ledger.json`, and every media file (posters
included). The step-by-step guide for game makers and helper authors is
CREATE.md, "Converting a Ren'Py project"; this file is the reference.

Every shipped file, posters included, lands at `media/<h[:2]>/<h>.<ext>`:
`h` is the sha256 of the bytes shipped and `ext` the TRUE shipped format
(docs/extracting.md, "Output layout"). Sources are sniffed by content (never by extension),
compatible images ship byte-identical or as verified lossless JPEG XL
when strictly smaller (libjxl through the pinned imagecodecs: PNG, GIF
and WebP pixels must decode back identical, a JPEG's recompression must
rebuild the original JPEG bytes exactly; animated images and `.jxl`
sources ship unchanged), incompatible ones
are converted to the smallest of PNG/JPEG q92/JXL, wrapped PNG/JPEG data
is carved, videos go by the measured rule (docs/extracting.md, Video
policy; probed container, video codec and HEVC tag, never the name):
what Safari and Chrome both play is copied unchanged at the true
container's extension, H.264/HEVC/VP9 in a container one of them
refuses (MKV, AVI, MPEG-TS, HEVC `hev1`) is remuxed into MP4 without
re-encoding (video stream only), and every other codec is transcoded
to H.264 faststart MP4, and posters are the frame at `startSeconds`
(a video whose poster cannot be made is dropped and reported with
ffmpeg's error, with a `warning:` summary line).
Identical outputs are one file, written once; a file already at its
content path is verified and left untouched, and one whose bytes do not
match its name stops the run with an error naming it (never
overwritten). Every decision lands in
`build-ledger.json`, whose `media` section records, per shipped file,
its source (loose path, or archive plus member) with the source's
sha256, each step with its parameters, the tool versions, and the
output's sha256 (docs/extracting.md, "Build ledger").

When an image is neither recognizable nor trivially carvable, its item
is dropped from the manifest and recorded (`decision: skipped`) in the
ledger — no placeholder is invented.

Sound (docs/plan.md Phase 47): the extractor reads the scripts' `play`,
`queue`, `stop` and `voice` statements and the literal `renpy.music` and
`renpy.sound` calls, and puts each cue on the next item as its manifest
`audio` (music, ambience loops, one-shots, voice). Every file a kept
item's cue names ships by the Audio policy (MP3, AAC in M4A, PCM WAV,
FLAC and WebM kept; Ogg Vorbis and Opus copied into WebM; anything else
re-encoded to Opus WebM) into `audio.tracks` with its decoded duration,
and its script (`<file>.js`, the bytes the player reads) beside it.
Music (unless played with `noloop`), ambience and video sounds loop, so
one that would ship as MP3 or Opus is re-encoded to AAC in M4A instead,
whose decode starts on the right sample (docs/content-format.md,
"Loop-safe formats"). Each video item's own sound becomes its
`videoSound` when it is audible and lasts to the item's range end. A
track that ships nothing, or starts past its end, drops its cues; the
summary counts the tracks shipped and dropped and the video soundtracks
found audible, silent or absent (docs/extracting.md, "Reading Ren'Py
audio" and "Shipping the sound").

## Setup

From the repo root:

```sh
.venv/bin/pip install -r requirements.txt --cache .tmp/pip-cache
.venv/bin/pip install -e ./converter --cache .tmp/pip-cache
.venv/bin/python tools/setup_media_tools.py
```

### Pinned media tools (docs/plan.md Phase 25)

The same game must give the same bytes on any machine, so the converter
encodes and decodes only with pinned tools, listed in
`converter/media-tools.json`:

- Pillow, imagecodecs (bundling libjxl) and numpy at the versions in
  `requirements.txt` (the pin file's `python` section must agree);
- ffmpeg and ffprobe from a static release build, each archive with its
  sha256: Martin Riedl's builds (one timestamped URL per platform) for
  `macos-arm64`, `linux-x86_64` and `linux-arm64`, and Gyan Doshi's
  essentials build for `windows-x86_64` (one zip holding `ffmpeg.exe`
  and `ffprobe.exe`, so both entries name it). Intel Macs are not
  supported.

`tools/setup_media_tools.py` downloads this platform's two archives,
refuses on a sha256 mismatch, extracts the binaries into
`.media-tools/<platform>/` at the repo root (gitignored, like `.venv/`;
not under `.tmp/`, which holds disposable scratch), checks their
reported version, then runs the golden-hash self-test. Nothing is
downloaded again while the pinned archive is installed (`--force`
re-downloads). PATH's ffmpeg, `cjxl` and `djxl` are never used.

A null `sha256`, a null `selftest.golden`, or a single null (or missing)
golden case means "not pinned yet": `--pin` records them (the archive
checksum cross-checked against the publisher's `<url>.sha256`, or the
line naming the archive in the checksums file an entry gives as
`sha256Url`) while every pinned case must still match, and the updated
pin file is committed. Nothing is written unless the whole self-test
passes, so a build whose output differs from the shared goldens is never
pinned, with one exception for the CPU. Some recipes give other bytes on
x86_64 than on arm64 whoever built ffmpeg (float audio encoders,
swscale, x264): those cases are listed in `selftest.cpuDependent`, and
only the user adds to that list. The `--pin` that first records a
platform's archive checksums also records that platform's own golden for
each listed case that differs, under
`selftest.platformGolden.<platform>.<case>`; any other differing case,
or a case that fails to run, refuses with nothing written. On that
platform the self-test then checks those cases against its own goldens
and every other case against the shared one. A platform golden for a
platform or case the pin file does not know, or for a case not in the
list, is an error. On a platform with a null archive checksum, setup
without `--pin` refuses and says why: no one has verified that
platform's build on such a machine yet. A newly added self-test case
lands as a null golden, and `kinetic-extract` refuses, naming the case,
until `--pin` records it. Pinned values are only ever verified, never
overwritten by `--pin`. When a deliberate recipe change alters one
case's bytes, re-record exactly that case with `--repin CASE`
(repeatable; it prints old and new values, and every other case must
still match); on a platform that holds its own golden for CASE, `--repin
CASE` re-records that one, and the shared golden is re-recorded on a
platform without one. To move to a new ffmpeg, change the version and
URLs, null the checksums and goldens, and re-run `--pin`.

Encoders run single-threaded and bitexact: every ffmpeg command carries
`-filter_threads 1`, `-threads 1` for the decoder and the encoder,
`-fflags +bitexact -flags:v +bitexact -flags:a +bitexact` and
`-map_metadata -1`; JPEG XL encodes and decodes with one thread at effort
9; Pillow saves spell out every parameter.

The self-test runs the committed samples in `tests/data/selftest/`
(PNG, JPEG, WebP, GIF, a short H.264/AAC MP4; `make_samples.py` made
them) through each converter tool path (Pillow decode and encode,
JXL lossless of PNG and of WebP pixels, JPEG recompression and
reconstruction, ffprobe, the poster frame, the
H.264 transcode) and compares each output's sha256 with
`selftest.golden`. `kinetic-extract` repeats the check at start and
refuses to run on a missing install, a version or binary that differs
from the pins, unpinned goldens, or any mismatch, naming the tool with
expected and actual hashes. A pass is cached in
`.media-tools/<platform>/selftest-cache.json` under a key built from the
tool versions and the hashes of the binaries, samples, recipe sources
and goldens, so a normal start only re-hashes files.

`KINETIC_MEDIA_TOOLS_DIR` is a test-only override (set by
`tests/conftest.py`) pointing the lookup at the system ffmpeg and
skipping the pin checks with a warning. Never set it for a real
conversion: the output is not reproducible.

## Usage

```sh
.venv/bin/kinetic-extract <renpy_project> <out_dir>
.venv/bin/python -m kinetic_extract <renpy_project> <out_dir>
```

`<renpy_project>` may be a directory containing `game/`, a `game/`
directory itself, or a macOS `.app` bundle (resolves
`Contents/Resources/autorun/game`). `--width`/`--height` override the
display resolution; the default is the most common image size among
referenced source images (Pillow), falling back to 1280x720.

The manifest's `storyId` (docs/content-format.md) comes from the
project: `config.save_directory`, else `config.name`, else the project
folder name (without `.app`), slugified; a slice still reads it from
`options.rpy`. Its `title` (shown atop the player's Esc screen and as
the page title) is `config.name`, else the folder name with `_`/`-`
runs read as spaces. Its `version` (the game's own release) is the
`config.version` string literal, trimmed and cut to 40 characters, and
absent when that is anything else. `--title TEXT`, `--game-version
TEXT` and `--story-id ID` override them (an ID that is not a valid
`storyId`, or a title or version that is blank or too long, is a usage
error). The summary prints all three and their sources. `--version`
on `kinetic-extract` and `kinetic-media` prints Kinetic's own version
(`Kinetic <VERSION>`, the repo's `VERSION` file), not the game's, and
exits.

`--decoder MODULE:FUNC` (repeatable, chained in order) runs a game's
own unwrapping hook over the complete bytes of every media source, loose
file or `.rpa` member, before format detection. MODULE is a module name
or a `.py` path; the function returns the decoded bytes or `None` for
unchanged, and raises on data it recognises but cannot decode, which
stops the run naming the source. Each change is a `decode` step in the
ledger with the hook's code hash (docs/extracting.md, "Decoder hooks").

Slice options (docs/plan.md Phase 11) extract part of a big game:
`--label NAME` starts the walk at that label and follows the story
from there (docs/extracting.md, "The walk follows labels"),
`--max-items N` stops after N manifest items, and `--files GLOB` walks
only the scripts matching GLOB, loose or archived (a `.rpy` pattern
also takes a `.rpyc` with no `.rpy`; docs/extracting.md, "Which scripts
are walked"). With none of them the whole project is extracted, as
before. Requested slice options are recorded under `slice` in
`build-ledger.json`.

Several projects (a game's episodes, in story order) make one game:
`kinetic-extract <episode1> <episode2> [...] <out_dir>`. Episode 2's
items follow episode 1's in one manifest, every id from project N gets
the prefix `epN-` (unique, and stable across re-runs in the same order),
and one `media/` holds identical media once. The `storyId`, `title`
and `version` come from the first project unless given. Ledger media sources carry
`"project": N`. The slice options need a single project. A single
project's output is unchanged. Details: docs/extracting.md, "Several
episodes, one game".

Ren'Py translations (docs/plan.md Phase 56 item 9) under
`game/tl/<language>/` become language files, `lang/<tag>.json` and
`lang/<tag>.js`, listed in the manifest's `languages`, with
`lang.schema.json` beside the manifest: dialogue blocks matched to items
by Ren'Py's own translation identifier (computed from the sources by
kinetic_extract.translations), `strings` blocks for route labels,
prompts, speakers, title and version. Style and python blocks and
per-language replacement files are ignored and counted, and the summary
reports each language's matches and coverage. `--language-map NAME=TAG`
(repeatable) gives the tag of a language name the built-in table does
not know, or overrides it; `--base-language TAG` names the language the
game's script is in (the manifest's `language`, so `tl/english` becomes
an English language file); `--no-translations` leaves translations out.
`tl/` is never part of the script walk. Details: docs/extracting.md,
"Translations".

An `if`/`elif`/`else` chain on one variable the script sets becomes a
decision (docs/plan.md Phase 60 item 6), one that `follows` the menu
whose choices alone set it or an ordinary one labelled by ranges or in
words, in the base language and each language file's words (the
player's catalogue, `converter/condition-words.json`). `--condition-names
FILE` (a JSON object of variable to reader words, one string or an
object of language tag to words) names the variables in the labels.
Details: docs/extracting.md, "Conditions".

### kinetic-media ship

```sh
.venv/bin/kinetic-media ship <game_root> <out_dir> --list requests.json \
    [--decoder MODULE:FUNC ...]
```

This runs the media work without a story parse, for helpers that build
the story themselves. The list is a JSON array of `{"source": {"path":
...} | {"archive": ..., "member": ...}, "kind":
"image"|"video"|"audio", "startSeconds"?: N, "loops"?: true, "id"?:
"..."}`, with paths relative to `<game_root>` (`loops` marks an audio
track that loops). Outputs land in `<out_dir>/media/` by the same code
as kinetic-extract. `<out_dir>/media-ledger.json` holds
`mediaTools`, `decoders`, `media` and a `requests` list giving each
request's `file`/`poster`/`width`/`height`/`durationSeconds`, decision
and notes. Requests with a missing or unusable source come back without
a `file`, as do audio requests of a video whose sound is `silent` or
absent (`no audio`), and the run still exits 0. A hook failure exits
1, and a bad list exits 2. Shipping into the same folder again merges
into its ledger; to ship several episodes into one folder, use the
folder holding all of them as `<game_root>` every time, so one root
rebuilds them all. The format and merge rules are in
docs/extracting.md, "kinetic-media ship".

### kinetic-media rebuild

```sh
.venv/bin/kinetic-media rebuild <game_root> [<game_root> ...] <folder> \
    [--decoder MODULE:FUNC ...] [--out DIR]
```

This makes every output in `<folder>`'s `build-ledger.json` and/or
`media-ledger.json` again from the original files under `<game_root>`
(for a game kinetic-extract made from several projects, every project in
the same order).
It runs the recorded steps through the same step code the converter
uses, and checks source sha256s, output sha256s and the folder's
`media/`. Give the same `--decoder` hooks the conversion ran. The
ledger's `mediaTools` must equal the current pinned tools, or the
rebuild refuses (exit 2); a ledger made on another platform (its
`mediaTools.platform`, `macos-arm64` when absent) stops with `made on
<platform>; rebuild there to verify` (exit 3), since the CPU-dependent
recipes give other bytes there. By default it only verifies; `--out DIR` also
writes the rebuilt `media/` tree. Exit 0 means everything matched.
Exit 1 means something is missing, unsupported or mismatched, and each
problem is named by its output path. The details are in
docs/extracting.md, "kinetic-media rebuild". It never reads the reuse
cache: every step is encoded again.

### Reuse cache

`kinetic-extract` and `kinetic-media ship` remember each image decision,
transcode, remux and poster in `.tmp/kinetic-media-cache/` at the repo root,
keyed by the sha256 of the bytes being encoded (after decoder hooks),
the recipe and the run's `mediaTools`. A re-run with the same inputs
and tools encodes nothing and writes the same folder byte for byte.
Stored outputs are hash-checked when read; a corrupt one is encoded
again. `KINETIC_MEDIA_CACHE=DIR` moves the cache, `KINETIC_MEDIA_CACHE=off`
disables it, and deleting the directory is always safe. Details in
docs/extracting.md, "Reuse cache".

## Tests

```sh
.venv/bin/pytest converter/ tools/ -q -n auto
```

## Simplifications (MVP, per docs/plan.md Phase 10)

- The story is read as Ren'Py runs it, from `label start` through
  `jump`, `call` and `return`, fall-through, and the jumps and calls in
  `if`/`while` blocks, unconverted menus and shown screens, each
  statement once; a computed `jump`/`call expression` walks the labels
  named by string literals in the game's code. Unreached labels and
  scripts are listed in the ledger's `walk`, not emitted, unless
  `--also-label NAME` or `--include-unreached` adds them after the story
  (docs/extracting.md, "The walk follows labels"). A project with no
  `label start` is read in filename order.
- A `menu:` of two or more plain quoted choices becomes a decision:
  each choice's path is walked to where the choices meet, and each
  route's `result` is how its path ended (docs/extracting.md, "The walk follows labels").
  A route may hold any item: pictures, animations, videos and lines.
  Any other menu is skipped, the linear flow is kept, and
  `branchDetection` in the ledger says why.
- The first dialogue line under a `scene`/`show`/`movie` attaches to the
  media item; later lines become `text` items over the same visual. A
  route's first line said over the visual on screen at the menu repeats
  that visual when an earlier route showed another, since a `text` item
  shows the nearest earlier media item in the item array.
- Audio statements attach to the next item emitted. A video's own sound
  is used only when audible and as long as the item's range; a track
  that does not ship drops its cues (`audioTracks` in the ledger says
  why).
