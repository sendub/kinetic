# kinetic-extract

Ren'Py extractor MVP (docs/plan.md Phase 10): reads a Ren'Py project's
`game/*.rpy` sources with a statement-subset parser and writes a Kinetic
content folder (`manifest.json`, `manifest.js`, `build-ledger.json`).

Media references follow the `<id>.<ext>` naming convention, but asset
copying and derivation are the next task: the extracted folder is not yet
playable until the asset pass ships.

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
