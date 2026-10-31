# kinetic-extract

Ren'Py extractor MVP (docs/plan.md Phase 10): reads a Ren'Py project's
`game/*.rpy` sources with a statement-subset parser and writes a playable
Kinetic content folder: `manifest.json`, `manifest.js`,
`build-ledger.json`, and every media file (posters included).

Media references follow the `<id>.<ext>` naming convention with `ext` the
TRUE shipped format: assets are sniffed by content (never by extension),
compatible images ship byte-identical or as lossless JPEG XL when
strictly smaller (`cjxl`/`djxl`, probed at runtime), incompatible ones
are converted to the smallest of PNG/JPEG q92/JXL, wrapped PNG/JPEG data
is carved, native browser videos are copied and others are transcoded to
H.264 faststart MP4, and posters are the frame at `startSeconds`.
Identical sources dedup into one shared file. Every decision lands in
`build-ledger.json`.

When an image is neither recognizable nor trivially carvable, its item
is dropped from the manifest and recorded (`decision: skipped`) in the
ledger — no placeholder is invented.

## Setup

From the repo root:

```sh
.venv/bin/pip install -e ./converter --cache .tmp/pip-cache
```

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

## Tests

```sh
.venv/bin/pytest converter/ -q
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
