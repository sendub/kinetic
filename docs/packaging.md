# Packaging a Kinetic Novel

A Kinetic novel is a self-contained folder: the player bundle sitting next
to its content, playable by double-clicking `index.html` over `file://`.
The settled decision behind this shape is docs/stack.md § Distribution
decision; this file is the practical sheet.

## What a novel folder contains

- `index.html`: the entry point a reader double-clicks.
- `app.js`: the player as one classic (IIFE) bundle; `file://` blocks ES
  modules, so this is not a module build (docs/stack.md). Both files
  open with a comment naming the Kinetic version that built them and
  Kinetic's MIT notice, so the folder carries its license (README.md,
  "License").
- `manifest.json`: the manifest, source of truth (docs/content-format.md).
- `manifest.js`: the generated shim that hands the manifest to the page
  without a fetch, since `file://` blocks it; the validator rejects a
  shim that differs from `manifest.json`.
- The media the manifest references: pictures, animation frames, videos
  and their posters. A hand-made folder may keep them anywhere inside
  it; kinetic-extract and kinetic-media put every one under
  `media/<h[:2]>/<h>.<ext>`, named by its content.
- For each audio track of a game with sound (`.mp3`, `.m4a`, `.wav`,
  `.flac` or `.webm`; docs/content-format.md, "Audio"), its script
  `<file>.js`, which hands the player the file's bytes without a fetch
  (docs/content-format.md, "The script beside each audio file"). The
  player reads only the scripts: a content folder keeps each audio file
  beside its script, and the assembled folder ships the scripts alone.
- For a game with character voices (docs/content-format.md, "Voices"),
  each voice's reference clip under `voices/` (`.flac`, `.wav` and so on)
  and its script `<file>.js`, as for a track. The player hands the script's
  bytes to the voice engine, so the assembled folder ships the scripts and
  leaves the clips out, and a content folder keeps both. The voice model
  is never in a game folder or an app: a reader's Kinetic app downloads it
  into a folder of its own, after an opt-in (docs/stack.md, "Voice install
  decision").
- For a translated game (docs/content-format.md, "Translations"), a
  `lang/` folder: for each tag the manifest's `languages` lists, the
  language file `lang/<tag>.json` and its script `lang/<tag>.js`, which
  hands it to the page without a fetch as `manifest.js` does; the player
  loads only the language a reader is shown. A language with its own
  recorded voice lines keeps them under `lang/<tag>/lines/`, each with
  its script `<file>.js` as for a track: the assembled folder ships the
  scripts and leaves the audio files out, and a content folder keeps
  both. Not `lang.schema.json`, the language files' schema copy beside
  the manifest, which is for an author's editor as `manifest.schema.json`
  is.
- Unreferenced extras the converter leaves behind (such as
  `build-ledger.json`), which the player and the validator ignore. Not
  kinetic-extract's schema copy, `manifest.schema.json`: it is for an
  author's editor, and the assembled folder leaves it out (the
  manifest's `$schema` key stays; docs/content-format.md, Manifest).
- Optionally `<title>.app`, the macOS app that plays the folder, and
  `<title>.exe`, the Windows program that shows it in a window of its
  own over WebView2, made only when the author asks: `kinetic apps
  <folder> --mac --windows` (either flag alone makes one; in a checkout
  `tools/build_apps.py` is the same), or the same flags on `kinetic
  assemble` (CREATE.md, "Building the apps"). Each is a copy of a host
  program built once per release, given the game's title, storyId,
  first window size and icon. Each app carries its own words (menus,
  alert, error box) in every language of the player's catalogue, from
  `apps/host-words.json`, which `npm run i18n` writes; a host build
  stops with an error while that table is stale against the catalogue
  (apps/README.md, "The apps' own words").

## Building one

Assemble the content folder with `kinetic` (Installing the tools,
below):

```sh
kinetic assemble my-novel novel-play
```

The same command packages a converter output; both paths produce the
identical folder shape:

```sh
kinetic assemble extracted-dir novel-play
```

In a checkout, build the bundle first (`cd player && npm run build`)
and run `.venv/bin/kinetic` from the repo root; `tools/assemble_folder.py`
there is the same command. The output folder holds exactly what the
command places: the current bundle (the wheel's, or `player/dist/` in a
checkout; a stale `index.html` or `app.js` inside the content folder is
ignored), the content files, a generated
`manifest.js` when the content has only `manifest.json`, a generated
`lang/<tag>.js` for each listed language file that has no script, and
a generated script for each audio track file that has none; the
content's top-level `manifest.schema.json` and `lang.schema.json` are
not copied. It then leaves out each audio track file, each voice clip
and each recorded line a listed language file names
(`lang/<tag>/lines/`) whose script is there, unless an item also shows
that file; the content folder keeps them, and writes a missing voice or
line script as it does a track's. A non-empty
output is refused unless `--force` replaces it. The script prints the
file count and total size. Check the result with the validator; a clean
run exits 0:

```sh
kinetic validate novel-play
```

A folder already made takes a newer player with `kinetic upgrade
novel-play`, which replaces only its `index.html` and `app.js`
(CREATE.md, "Upgrading to a newer Kinetic"); `manifest.json`, media and
`lang/` stay as they are.

## Installing the tools

The tools that make a folder (converting, validating, assembling,
upgrading, checking) also come without a checkout, as one command,
`kinetic`, installed from a wheel attached to each GitHub release of
https://github.com/sendub/kinetic (docs/plan.md Phase 57), X.Y.Z being
the release:

```sh
python3 -m venv ~/kinetic-venv
~/kinetic-venv/bin/pip install https://github.com/sendub/kinetic/releases/download/vX.Y.Z/kinetic-X.Y.Z-py3-none-any.whl
~/kinetic-venv/bin/kinetic setup
```

It needs Python 3.12 or later; `kinetic check` also needs Node.js 22.12
or later (and Chrome for its `chrome` engine), and the Mac app needs
macOS. Media tools are pinned for `macos-arm64` (Apple silicon),
`windows-x86_64` and `linux-x86_64`, so `kinetic setup`, and with it
converting, works on those; on `linux-arm64`, not pinned yet, setup
stops and says so, and every other subcommand runs on any system. A
folder's media verify with `kinetic media rebuild` on the platform that
made them (its ledger's `mediaTools.platform`; exit 3 elsewhere).

`kinetic --help` lists the subcommands: `setup`, `extract`, `media`
(`ship`, `rebuild`, `posters`), `validate`, `assemble`, `apps`,
`upgrade`, `check`, `report`, `routes`, `export` and
`release-status`. Each wrapped tool
takes the arguments, prints the output and exits with the codes of the
command it stands for (CREATE.md, "Installing Kinetic").
`kinetic-extract` and `kinetic-media` install beside it, and in a
checkout `tools/*.py` keep working; those scripts are thin wrappers over
the same modules in `converter/kinetic_extract/`. `kinetic apps` makes
the macOS app and the Windows exe from the hosts the wheel carries
prebuilt, with no Swift or Go: the exe on any system, the Mac app on
macOS, which signs it with `codesign` (see "The app hosts" below).
The voice and translation tools (`tools/cast_voices.py`,
`tools/record_lines.py`, `tools/translations.py`) are not in the wheel
and need a checkout. The testing library for authors' own scripts is
in it: `kinetic check --library` prints the path a script imports
(CREATE.md, "A test script").

The wheel carries what the tools read from the repo in a checkout,
under `kinetic_extract/data/`: the repo's VERSION,
`converter/media-tools.json`, the two schemas from docs/, the media
self-test's samples, vendored unrpyc, the built player (`index.html`
and `app.js`, which `kinetic assemble` and `kinetic upgrade` copy),
the testing library (`player/scripts/testing/kinetic.mjs`) bundled with
puppeteer-core into one ES module, `check/kinetic.mjs`, and check-game
bundled on top of it, `check/check-game.mjs`, which imports
`./kinetic.mjs`, so puppeteer-core is in the wheel once, with the WebKit
driver beside them (`check/kinetic-webkit-driver`, macOS arm64), the
repo's LICENSE and `apps/host-words.json`, the two app hosts
(`apps/macos/kinetic` and `apps/windows/kinetic.exe`), and the
release's checklist: `release/progress.md` and `release/CHANGELOG.md`
(docs/progress.md and CHANGELOG.md) with `release/build.json`, the
commit the wheel was built from (`git rev-parse HEAD`) and whether the
tree was clean (both null when git could not say). `kinetic
release-status [--json]` reads those three: the version, the commit
(`-dirty` when the tree was not clean), the checked and open boxes in
that progress.md and the version's CHANGELOG entry, so a gate on a
finished checklist needs no network; in a checkout it reads the repo's
files and asks git, and a wheel built before 1.13.0, without them,
exits 1. `kinetic check`
runs check-game with the system Node, and a creator's script imports
the library by the path `kinetic check --library` prints, with no npm
and no `node_modules`; either needs Node.js at the version
puppeteer-core needs (22.12 or later; the check names it when Node is
missing or older) and Chrome, found as check-game finds it
(`KINETIC_CHROME`, else the usual place). The engine `auto` uses
WebKit on macOS, through the prebuilt driver, with no Swift; a wheel
without the driver tests on Chrome and says why.

Where an installed Kinetic writes, `KINETIC_HOME` when set, else the
system's place for an application's data and caches. The media tools
are what `kinetic setup` installs; the caches hold encodes, files read
from archives, decompiled scripts, and the browser profiles and crash
dumps of check-game and the testing library (`check/` in the caches):

| | Media tools | Caches |
| --- | --- | --- |
| `KINETIC_HOME` set | `$KINETIC_HOME/media-tools/` | `$KINETIC_HOME/cache/` |
| macOS | `~/Library/Application Support/Kinetic/media-tools/` | `~/Library/Caches/Kinetic/` |
| Windows | `%LOCALAPPDATA%\Kinetic\media-tools\` | `%LOCALAPPDATA%\Kinetic\Cache\` |
| Linux | `$XDG_DATA_HOME/kinetic/media-tools/` (`~/.local/share`) | `$XDG_CACHE_HOME/kinetic/` (`~/.cache`) |

`KINETIC_MEDIA_CACHE` still moves or disables the encode cache. In a
checkout nothing changes: the package sees it sits in
`<repo>/converter/kinetic_extract/` beside the repo's VERSION and
`player/package.json`, reads the repo's files, installs the media tools
into `.media-tools/`, keeps its caches under `.tmp/`, and ignores
`KINETIC_HOME`; `kinetic check` runs
`player/scripts/testing/check-game.mjs`, and `--library` prints the path
of `player/scripts/testing/kinetic.mjs`, both of which need `npm ci` in
`player/`.

The wheel is built in a checkout with

```sh
.venv/bin/python tools/build_wheel.py [--out DIR]
```

which builds the player afresh into a staging folder (player/dist/ is
left alone) and refuses a bundle not stamped with the checkout's
VERSION, bundles the testing library and check-game and builds the
WebKit driver (`player/scripts/bundle-check.mjs --driver`), builds the
two app hosts,
and writes `dist/kinetic-<version>-py3-none-any.whl` with `pip wheel`.
It needs Node and `player/node_modules`, macOS with a Swift toolchain
(the Mac host and the driver) and Go 1.27 or later (the Windows host):
the release machine's tools, never an installer's. The wheel is about
5.0 MB (4.79 MiB, 92 files), of which the Windows host is 7.8 MB, the
testing library (`check/kinetic.mjs`) 2.4 MB, the player 1.4 MB, the
WebKit driver 0.7 MB, the Mac host 0.6 MB, `release/progress.md` 0.4
MB and check-game 24 KB before compression (2026-11-20). Each release's
closing commit builds the wheel this way and attaches it to the GitHub
release `vX.Y.Z`, which is where the install line above downloads it
from.

### The app hosts

`kinetic apps` (kinetic_extract/apps.py) copies one of two programs
into each game folder and writes the game's settings into the copy;
each host reads them once at launch, which costs well under a
millisecond and nothing afterwards (docs/plan.md Phase 57 item 10):

- **The Mac host** (`apps/macos/app/`, arm64, macOS 12 or later) reads
  `KineticStoryId`, `KineticTitle`, `KineticWindowSize` ({Width,
  Height}) and `KineticVersion` from its bundle's Info.plist, which
  macOS reads anyway (`apps/macos/app/HostSettings.swift`). `kinetic
  apps --mac` writes that Info.plist (with the bundle id
  `org.kinetic.game.<storyId>`), the icon as `AppIcon.icns` (Pillow,
  no `sips` or `iconutil`) and `LICENSE`, then signs the bundle ad hoc
  with `codesign`, so the Mac app still needs macOS.
- **The Windows host** (`apps/windows/`, x86-64 GUI) reads RT_RCDATA
  resource 3, a small UTF-8 JSON object (`{"kineticVersion",
  "storyId", "title", "windowSize": {"width", "height"}}`), through
  FindResourceW from its own mapped image (`apps/windows/settings.go`).
  `kinetic apps --windows` rewrites the copy's resources on any system
  (kinetic_extract/windows_resources.py, `replace_resources`): it
  keeps the host's application manifest and license texts (RT_RCDATA 1
  and 2), and writes the icon (RT_ICON and RT_GROUP_ICON), the version
  resource (the title as its description, the storyId) and the
  settings. It replaces the exe's `.rsrc` section, which the Go linker
  puts last in the file and in memory (the host build checks), so the
  new section may grow or shrink: its sizes, SizeOfImage and the
  resource data directory follow, and the PE checksum is computed
  afresh (imagehlp's own `MapFileAndCheckSum` agrees on the user's
  Windows PC), though Windows checks it only for drivers and DLLs
  loaded into system processes. The host links with `-buildid=`, so
  writing a game's resources into it gives the very exe that linking
  them in would, byte for byte but that checksum (the linker leaves
  0); tools/test_build_apps.py checks this.

Both hosts carry what is the same for every game compiled in: the voice
helper and the hosts' own words table. `<binary> --self-check FILE`
writes the settings the host read (and the Kinetic version that made
the app) to FILE as JSON and exits at once, with no window (the exe
has no console, hence a file): `{"host": "macos", "storyId", "title",
"windowSize": {"width", "height"} or null, "kineticVersion",
"bundleId"}` from the Mac binary inside the app
(`<title>.app/Contents/MacOS/kinetic`), the same keys but `bundleId`
from the exe, `"host": "windows"`.

In a checkout `kinetic apps` builds the hosts on first use into
`.tmp/app-hosts/<kind>-<hash>/`, the hash covering every input
(sources, the generated embeds, flags, the toolchain's version, the
license texts), so it needs Swift (the Mac host) or Go (the Windows
host) there, as the release build does, and reuses a build until an
input changes. kinetic_extract/app_hosts.py says how each is built.

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

A folder also plays from any static web host as it is (CREATE.md,
"Serving from a web host"); it is not a target Kinetic designs for.

## Size expectations

The bundle is about 1.4 MB (`app.js` about 1.28 MB, `index.html` about
113 KB, measured 2026-11-17, against 354 KB for `app.js` on 2026-11-13,
before translations and the player's words in 39 languages). Everything
else is media, so beyond that fixed 1.4 MB a novel's size is its media's
size. The demo fixture assembles to 32 files, about 1.66 MB, and the
audio demo to 45 files, about 3.9 MB, of which its 15 short mono tracks,
shipped as their scripts, are 2.2 MB; the audio files themselves are 1.7
MB (both 2026-11-17). The extracted demo (fixtures/renpy_demo)
assembles to 27 files, about 1.69 MB (2026-11-27).

Sound costs a third more than its files, since an assembled folder
ships each as its base64 script. MP3, AAC or Opus at 96-128 kb/s takes
about 1 MB a minute, so 1-1.3 MB a minute as a script; a looping track
kinetic-media re-encodes to AAC at 192 kb/s takes 1.4 MB a minute, 1.9
MB as a script. PCM WAV, which kinetic-media keeps byte-identical, takes
about 10.6 MB a minute at 16-bit stereo 44.1 kHz, 14 MB as a script. A
content folder holds both the files and their scripts. In memory the
player keeps each track it plays decoded, 23 MB a minute in stereo at
48 kHz whatever the format, under a 200 MiB cap (docs/perf.md,
"Navigation with sound").

## Honest caveats

- The reader needs a modern browser. `.jxl` images decode on Chrome/Edge
  117+, Safari 17+, or Firefox 133+, and `.mkv` video is reliably
  Chromium-class; the full matrix is docs/content-format.md § Items.
  When a reader's browser lacks a format, the fix is content-side:
  re-encode to a format it plays.
- In a browser, sound starts with the reader's first key or click other
  than Esc or a Cmd, Ctrl or Alt shortcut, after every load, whatever the
  browser allows, and a pill says "Press any key for sound" until then
  (docs/player.md, "When sound starts"). The macOS app plays sound at
  launch. The Windows exe asks WebView2 to do the same, which is not
  verified on Windows.
- Generated speech needs the Mac app (Apple silicon, macOS 14 or later) or the
  Windows program (an NVIDIA card, driver 570.65 or later) and a one-time
  download of about 3.3 GB on a Mac or 6.8 GB on Windows, shared by every
  Kinetic game on the machine, which a reader starts in the Esc screen's Volumes
  box. In a browser, a game with voices and no recorded lines plays silently.
- Videos always play muted: a video's own sound ships as a separate audio
  track, its item's `videoSound` (docs/content-format.md, "Audio").
- Ogg tracks (`.ogg`, `.oga`, `.opus`) pass the validator with a warning:
  Safari before 18.4 does not play them, and WebKit's decode of Vorbis
  in Ogg loses its first 128 samples. Ship them through kinetic-media,
  which copies the stream into WebM, or re-encodes a looping Opus to AAC.

## Tauri: superseded by the game apps

This section once held a Tauri v2 wrapper in reserve for the day a real
`.app` was wanted (docs/stack.md § Revisit triggers). The per-game apps
replace it (docs/plan.md Phase 43): the macOS app is a small Swift
program over the system WebKit that each release compiles once with
Xcode or the Command Line Tools and `kinetic apps` signs ad hoc, and
the Windows exe is a small Go program (`apps/windows/`) that shows the
folder through WebView2, which Go builds for Windows from any system.
No Rust toolchain is needed and the folder's files stay as they are
beside them. The page
talks to either app over one small protocol (apps/README.md): the Esc
screen's Exit and Fullscreen | Window.

## Proof

`npm run package-proof` (from `player/`) reruns the headless acceptance:
it assembles `fixtures/demo` into `.tmp/pkg-demo` and the extracted
slice (`.tmp/extract-demo`, made by `.venv/bin/kinetic extract
fixtures/renpy_demo .tmp/extract-demo`) into `.tmp/pkg-extract` with the
script above, proves the overwrite refusal and `--force`, passes the
validator on both, and loads each folder in headless Chrome over
`file://` with a fresh profile: first load shows the key help, the first
visual paints, space advances one item, Escape opens and closes the
help, and the console stays clean. Finder's `open` does not exist in a
headless run, so the documented equivalent is proven instead:
`index.html` exists on disk and the `file://` URL of that exact path
loads and plays, which is the same handoff a double-click makes.

Its wheel stage then proves the release's install path away from the
checkout's own tools. It builds the wheel with `tools/build_wheel.py`,
installs it into a fresh venv under `.tmp/pkg-wheel/` and, with
`KINETIC_HOME` there too, runs the installed `kinetic`: `setup` (the
checkout's installed media tools are hard-linked into the home first,
so nothing is downloaded but the self-test still runs; without them
setup downloads), `extract` of `fixtures/renpy_demo`, whose manifest
must hold its five decisions (one that `follows` another, one with a
`"return"` route) and an animation with `frameSeconds` and
`holdLastFrame`, `validate`, `report`, `assemble --mac --windows`
(`--windows` alone off macOS),
`check --steps all`, and on macOS the built app's `--self-check`, whose
settings must name the game and this version. Then `release-status
--json`, whose version, commit, counts and CHANGELOG entry must match
the checkout's; `upgrade --dry-run`, plain and with `--to`, which must
leave the assembled folder unchanged (every entry's size, time and
mode) and make no copy; `upgrade --to`, whose copy must share the
items' media files' inodes with the folder, hold its own `app.js`,
validate, and on macOS keep a Mac app `codesign --verify --strict`
accepts, the folder still unchanged; `upgrade --to --link-media`, on a
copy of the assembled folder with a file nothing names added under
`media/`, whose copy must share that file's inode, whose copy line's
counts must match the folder's files (every regular file under `media/`
linked, the rest copied), as its dry run's must, and which must leave
that folder unchanged; and a script under the work
folder, with no puppeteer-core in a `node_modules` above it, that
imports the path `check --library` prints, opens the game with
`openGame` on Chrome (and WebKit on macOS), steps one item, and opens
it again with `savedState` set to the record the player saved, which
must open at that item with no errors. The venv, the home and the
wheel are removed afterwards. It needs what `tools/build_wheel.py`
needs (above).
