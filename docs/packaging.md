# Packaging a Kinetic Novel

A Kinetic novel is a self-contained folder: the player bundle sitting next
to its content, playable by double-clicking `index.html` over `file://`.
The settled decision behind this shape is docs/stack.md § Distribution
decision; this file is the practical sheet.

## What a novel folder contains

- `index.html`: the entry point a reader double-clicks.
- `app.js`: the player as one classic (IIFE) bundle; `file://` blocks ES
  modules, so this is not a module build (docs/stack.md).
- `manifest.json`: the manifest, source of truth (docs/content-format.md).
- `manifest.js`: the generated shim that hands the manifest to the page
  without a fetch, since `file://` blocks it; the validator rejects a
  shim that differs from `manifest.json`.
- The media the manifest references: pictures, animation frames, videos
  and their posters, and the audio track files of a game with sound
  (`.mp3`, `.m4a`, `.wav`, `.flac` or `.webm`; docs/content-format.md,
  "Audio"). A hand-made folder may keep them anywhere inside it;
  kinetic-extract and kinetic-media put every one under
  `media/<h[:2]>/<h>.<ext>`, named by its content.
- Beside each audio track file, its script `<file>.js`, which hands the
  player the file's bytes without a fetch (docs/content-format.md, "The
  script beside each audio file").
- Unreferenced extras the converter leaves behind (such as
  `build-ledger.json`), which the player and the validator ignore.
- Optionally `<title>.app`, the macOS app that plays the folder, and
  `<title>.exe`, the Windows program that shows it in a window of its
  own over WebView2, built only when the author asks: `tools/build_apps.py <folder>
  --mac --windows` (either flag alone builds one), or the same flags on
  `tools/assemble_folder.py` (CREATE.md, "Building the apps").

## Building one

Build the bundle once, then assemble. From the repo root:

```sh
(cd player && npm run build)
.venv/bin/python tools/assemble_folder.py my-novel novel-play
```

The same command packages a converter output; both paths produce the
identical folder shape:

```sh
.venv/bin/python tools/assemble_folder.py extracted-dir novel-play
```

The output folder holds exactly what the script places: the current
bundle from `player/dist/` (a stale `index.html` or `app.js` inside the
content folder is ignored), the content files, a generated
`manifest.js` when the content has only `manifest.json`, and a
generated script for each audio track file that has none. A non-empty
output is refused unless `--force` replaces it. The script prints the
file count and total size. Check the result with the validator; a clean
run exits 0:

```sh
.venv/bin/python tools/validate_content.py novel-play
```

## Double-click behavior and transport

Double-clicking `index.html` opens the novel in the default browser, and
the first keypress or click enters fullscreen (CREATE.md § Playing the
folder). The `file://` constraints that make this work are documented
once, in docs/stack.md; they are already satisfied by the bundle and the
shim, so a folder needs no server and nothing installed.

To send a novel to a reader, zip the folder and send the archive:

```sh
zip -r novel.zip novel-play
```

The reader unzips anywhere and double-clicks `index.html`. Locally
generated files carry no quarantine flag, so nothing prompts
(docs/stack.md § Distribution decision). A downloaded zip is
quarantined, so the macOS app in it will not open there; its readers
use `index.html`. On Windows a downloaded zip carries the Mark of the
Web, so the unsigned exe in it first meets SmartScreen's "Windows
protected your PC" (More info, Run anyway), unless the reader unblocks
the zip before extracting it (CREATE.md, "Building the apps").

## Size expectations

The bundle is about 415 KB (`app.js` about 325 KB, `index.html` about
90 KB, measured 2026-11-10); everything else is media, so a novel's size
is its media's size. The demo fixture assembles to 30 files, about 650
KB, and the audio demo to 45 files, about 1.8 MB, of which its 15 short
mono tracks are 1.1 MB (2026-11-10). The extracted one-video slice
assembled to 13 files, about 290 KB, with the smaller bundle of
2026-11-02.

Sound costs what its files cost. MP3, AAC or Opus at 96-128 kb/s takes
about 1 MB a minute, while PCM WAV, which kinetic-media keeps
byte-identical, takes about 10 MB a minute at 16-bit stereo 44.1 kHz.

## Honest caveats

- The reader needs a modern browser. `.jxl` images decode on Chrome/Edge
  117+, Safari 17+, or Firefox 133+, and `.mkv` video is reliably
  Chromium-class; the full matrix is docs/content-format.md § Items.
  When a reader's browser lacks a format, the fix is content-side:
  re-encode to a format it plays.
- In a browser, sound starts with the reader's first key or click, and a
  pill says "Press any key for sound" until then (README.md, "Playing").
  The macOS app plays sound at launch. The Windows exe asks WebView2 to
  do the same, which is not verified on Windows.
- Videos always play muted: a video's own sound ships as a separate audio
  track, its item's `videoSound` (docs/content-format.md, "Audio").
- Ogg tracks (`.ogg`, `.oga`, `.opus`) pass the validator with a warning:
  WebKit times them wrong and Safari before 18.4 does not play them.
  Ship them through kinetic-media, which copies the stream into WebM.

## Tauri: superseded by the game apps

This section once held a Tauri v2 wrapper in reserve for the day a real
`.app` was wanted (docs/stack.md § Revisit triggers). The per-game apps
replace it (docs/plan.md Phase 43): the macOS app is a small Swift
program over the system WebKit that `tools/build_apps.py` compiles
with Xcode or the Command Line Tools and signs ad hoc, and the Windows
exe is a small Go program (`apps/windows/`) that shows the folder
through WebView2, which Go builds for Windows from any system. No Rust toolchain is
needed and the folder's files stay as they are beside them. The page
talks to either app over one small protocol (apps/README.md): the Esc
screen's Exit and Fullscreen | Window.

## Proof

`npm run package-proof` (from `player/`) reruns the headless acceptance:
it assembles `fixtures/demo` into `.tmp/pkg-demo` and the extracted slice
into `.tmp/pkg-extract` with the script above, proves the overwrite
refusal and `--force`, passes the validator on both, and loads each
folder in headless Chrome over `file://` with a fresh profile: first load
shows the key help, the first visual paints, space advances one item,
Escape opens and closes the help, and the console stays clean. Finder's
`open` does not exist in a headless run, so the documented equivalent is
proven instead: `index.html` exists on disk and the `file://` URL of that
exact path loads and plays, which is the same handoff a double-click
makes.
