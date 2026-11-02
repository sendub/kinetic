# kinetic-extract

Ren'Py extractor MVP (docs/plan.md Phase 10): reads a Ren'Py project's
`game/*.rpy` sources with a statement-subset parser and writes a playable
Kinetic content folder: `manifest.json`, `manifest.js`,
`build-ledger.json`, and every media file (posters included).

Every shipped file, posters included, lands at `media/<h[:2]>/<h>.<ext>`:
`h` is the sha256 of the bytes shipped and `ext` the TRUE shipped format
(docs/extracting.md, "Output layout"). Sources are sniffed by content (never by extension),
compatible images ship byte-identical or as verified lossless JPEG XL
when strictly smaller (libjxl through the pinned imagecodecs: PNG, GIF
and WebP pixels must decode back identical, a JPEG's recompression must
rebuild the original JPEG bytes exactly; animated images and `.jxl`
sources ship unchanged), incompatible ones
are converted to the smallest of PNG/JPEG q92/JXL, wrapped PNG/JPEG data
is carved, MKV videos are copied unchanged whatever the codec (with a
`warning:` summary line and item note when no target browser plays the
codec), other native browser videos are copied and the rest are
transcoded to H.264 faststart MP4, and posters are the frame at `startSeconds`.
Identical outputs are one file, written once. Every decision lands in
`build-ledger.json`, whose `media` section records, per shipped file,
its source (loose path, or archive plus member) with the source's
sha256, each step with its parameters, the tool versions, and the
output's sha256 (docs/extracting.md, "Build ledger").

When an image is neither recognizable nor trivially carvable, its item
is dropped from the manifest and recorded (`decision: skipped`) in the
ledger — no placeholder is invented.

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
- ffmpeg and ffprobe from a static release build (Martin Riedl's builds,
  one timestamped URL per platform: `macos-arm64`, `macos-x86_64`,
  `linux-x86_64`, `linux-arm64`), each archive with its sha256.

`tools/setup_media_tools.py` downloads this platform's two archives,
refuses on a sha256 mismatch, extracts the binaries into
`.media-tools/<platform>/` at the repo root (gitignored, like `.venv/`;
not under `.tmp/`, which holds disposable scratch), checks their
reported version, then runs the golden-hash self-test. Nothing is
downloaded again while the pinned archive is installed (`--force`
re-downloads). PATH's ffmpeg, `cjxl` and `djxl` are never used.

A null `sha256`, a null `selftest.golden`, or a single null (or
missing) golden case means "not pinned yet": `--pin` records them (the
archive checksum cross-checked against the publisher's `<url>.sha256`)
while every pinned case must still match, and the updated pin file is
committed. A newly added self-test case lands as a null golden, and
`kinetic-extract` refuses, naming the case, until `--pin` records it.
Pinned values are only ever verified, never overwritten by `--pin`. When
a deliberate recipe change alters one case's bytes, re-record exactly
that case with `--repin CASE` (repeatable; it prints old and new
values, and every other case must still match). To move to a new
ffmpeg, change the version and URLs, null the checksums and goldens,
and re-run `--pin`.

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
runs read as spaces. `--title TEXT` and `--story-id ID` override them
(an ID that is not a valid `storyId` is a usage error). The summary
prints both and their sources.

`--decoder MODULE:FUNC` (repeatable, chained in order) runs a game's
own unwrapping hook over the complete bytes of every media source, loose
file or `.rpa` member, before format detection. MODULE is a module name
or a `.py` path; the function returns the decoded bytes or `None` for
unchanged, and raises on data it recognises but cannot decode, which
stops the run naming the source. Each change is a `decode` step in the
ledger with the hook's code hash (docs/extracting.md, "Decoder hooks").

Slice options (docs/plan.md Phase 11) extract part of a big game:
`--label NAME` starts the walk at that label, `--max-items N` stops
after N manifest items, and `--files GLOB` parses only the `game/*.rpy`
files matching GLOB (filename order). With none of them the whole
project is extracted, as before. Requested slice options are recorded
under `slice` in `build-ledger.json`.

## Tests

```sh
.venv/bin/pytest converter/ tools/ -q
```

## Simplifications (MVP, per docs/plan.md Phase 10)

- Multiple `.rpy` files are processed in filename order and concatenated
  into one linear flow.
- `jump`/`call` targets inside the same file are noted and the walk
  continues linearly; unknown (cross-file) targets are noted as well.
- `menu:` branches are unsupported: the block is skipped, the linear flow
  before it is kept, and the branch is reported in the ledger.
- The first dialogue line under a `scene`/`show`/`movie` attaches to the
  media item; later lines become `text` items over the same visual.
