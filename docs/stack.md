# Tech Stack: Investigation and Decisions

Working notes for choosing the stack for Kinetic, a kinetic visual novel
player (see README.md) with a Ren'Py content converter. Decisions in this file
are settled unless a Revisit trigger fires; implementation follows
docs/plan.md.

## Requirements that drive the stack

From README.md:

- Display ordered images, animation frame groups, and video, fullscreen,
  with overlay text.
- Keys: space (advance), tab (fast skip), h (hide text), b (bookmark),
  m (branch map, with the bookmarks on it: docs/plan.md Phases 31 and
  35; `t`, the old bookmark list, is gone), e (jump to the furthest
  point read), u (next unseen), v (sound on or off, docs/plan.md Phase
  47), Esc (settings). Scroll wheel walks the story back and forward
  (docs/plan.md Phase 27).
- Navigation latency under 1/24 s (41 ms). Pre-decode and pre-size are the
  mechanisms; runtime video decode must never gate a navigation.
- macOS, no runtime dependencies except browser-related stuff, no
  gatekeeper friction (no binary, or a tiny one).
- Optional sound: music, ambience loops, one-shots, voice lines and a
  video's own soundtrack (docs/plan.md Phase 47; Audio decision below).
  No menus, always fullscreen.
- An extractor from Ren'Py project files to our format.

## Environment facts (verified 2025-10-31)

- Node v24.13.1, npm 11.8.0: present.
- Python 3.12.2, ffmpeg 6.1.1, macOS `sips`: present (the converter uses
  the pinned ffmpeg instead since Phase 25).
- No Rust toolchain (`cargo`/`rustc` absent). Agent conduct forbids
  installing system packages, so anything Rust-based needs a user install
  step first.

## Player host options considered

| Option | Verdict | Reason |
| --- | --- | --- |
| Electron | Rejected | Ships Chromium (~100 MB+): a runtime dependency and a gatekeeper-sized binary. Everything else it buys, the browser gives free. |
| Tauri v2 | Superseded | ~5 MB Rust binary over system WKWebView; the best native story, and v2 is current (verified at v2.tauri.app). Needs a Rust install this machine lacks, plus two toolchains to operate. Was kept as an optional packaging phase; the per-game apps (Distribution decision) replace it with no Rust. |
| Swift / AppKit | Rejected | Smallest footprint, most work: windowing, text layout, image caching, video layer, and build tooling all hand-written. Slowest loop for implementing subagents. |
| Godot / LÖVE / pygame-ce | Rejected | Game-loop frameworks; video needs third-party bindings, overlay text and bookmark-list UI are awkward, unsigned app bundles draw gatekeeper attention. Overkill for a keyed slideshow. |
| Static web app in an installed browser | Chosen | README explicitly allows browser display. Every needed capability is a native web API: `HTMLVideoElement` (hardware H.264), `createImageBitmap` for pre-decode, IndexedDB for bookmarks/config, keyboard and wheel events, Fullscreen API. Zero added runtime; content is plain files, so gatekeeper checks nothing but the browser. Dev loop is `npm run dev` plus reload. |

Known constraints of the browser host, both accepted:

- Fullscreen requires a user gesture, so the app enters fullscreen on the
  first keypress or click. The first keypress is space, the documented
  advance key, so this adds no friction.
- `file://` blocks ES module scripts (Chrome and Safari). The build emits a
  single classic (IIFE) bundle, so `open index.html` works without a server.

## Player decisions

- Language: TypeScript, strict mode.
- UI: no framework. The app is one state machine plus a small DOM renderer
  and two overlay panels. Plain DOM and a subscribe/notify boundary between
  machine and renderer keep the machine unit-testable without a DOM.
- Build: esbuild, bundling to one classic `app.js` next to a handwritten
  `index.html`. Dev loop: esbuild `--servedir` (or `--watch`) plus browser
  reload; Vite not needed since there is no component tooling to justify.
- The player's own words: one catalogue by key (`player/src/i18n/`),
  English in TypeScript as the source, other languages compiled from
  gettext PO files under `player/locales/` into the bundle, plurals by
  `Intl.PluralRules` and numbers by `Intl.NumberFormat`, switchable live
  with no reload (docs/plan.md Phase 56; docs/verify-player.md, "The
  player's words"). No render module draws a literal.
- Lint/format: Biome, one tool for both, minimal config.
- Tests: Vitest for the state machine and pure modules (no DOM). Rendering
  and key handling verify through a documented manual checklist against the
  demo fixture.
- Video: H.264 MP4 (`yuv420p`, faststart), `<video muted playsinline>`.
  Muted autoplay is exempt from browser autoplay policies, so videos play
  without special handling. They stay muted now that Kinetic has sound:
  an unmuted video may be refused autoplay before the reader's first key
  and would stall the story. A video's own soundtrack plays as a separate
  track kept in step with it (`videoSound`, Audio decision below).
- Speed: converter pre-generates display-resolution images, per-frame
  animation strips, video poster frames, and bookmark source thumbnails.
  Runtime preloads cursor +/- a few items as `ImageBitmap` with an LRU
  cache. Navigation paints a prepared bitmap; 41 ms is then comfortably
  reachable, and we measure rather than assume (perf harness in the final
  phase).
- Persistence: IndexedDB in both modes (settings, bookmark list, reading
  progress, all keyed by item / decision / route id so content updates
  keep saves valid). Each story's record is stored under the manifest's
  `storyId` (`story:<id>`; the folder URL when a manifest has none, carried
  over once one is added), so moving or renaming the folder keeps
  progress. The seen set has records of its own in the same database
  (docs/plan.md Phase 46): a save writes the reader's place and only the
  items newly seen, so a save costs the same on a 160,000-item game read
  to the end as on its first screen (docs/perf.md, "Saves at scale"). The
  database stays `kinetic` version 1 with its two stores: a new store or
  index would need a version 2, which every older player on the origin
  would fail to open. Moving to another browser is an explicit Export /
  Import of a per-story JSON file on the Esc screen. No server, no
  files-from-browser problem.

## Audio decision

Settled in docs/plan.md Phase 47 (the user, 2026-11-09; the sound engine
changed 2026-11-11, item 16). Sound is optional: a manifest without
`audio` plays and validates as before (docs/content-format.md, "Audio").

- Formats (media rule b): keep what Chrome and WebKit both play and time
  right, which is MP3, AAC in M4A, PCM WAV, FLAC, and Vorbis or Opus in
  WebM. Vorbis or Opus in Ogg is copied into WebM without re-encoding,
  and anything else is re-encoded to Opus in WebM. On audio elements
  (2026-11-09), WebKit misreported an Ogg file's duration and ran its
  clock 4-7% slow, and Chrome played it 0.8 s past its end; Safari plays
  Ogg only from 18.4 (macOS 15.4). The same stream in WebM is right in
  both engines, and Safari has played Vorbis and Opus in WebM since
  15-17.4, inside the Safari 17 baseline JPEG XL already sets. The
  measurements and the full table are in docs/extracting.md, "Audio
  policy".
- Loop-safe formats (item 17): a track that loops (music, ambience, a
  video's sound) ships only in a format whose `decodeAudioData` starts
  on its first sample in Chrome and WebKit: AAC in M4A, Vorbis in WebM,
  WAV or FLAC (Opus in Ogg starts right too, but is Ogg). MP3 starts 576
  samples late in WebKit, and Opus in WebM loses 24 samples in Chrome,
  which would move every wrap, so kinetic-media re-encodes a looping MP3
  or Opus source to AAC in M4A at 192 kb/s, and the validator warns about
  a looping track in those formats (docs/content-format.md, "Loop-safe
  formats").
- Web Audio, not HTMLAudioElement (item 16). An element cannot start a
  sound at an exact moment. One that loops on its own (its `loop`, or a
  seek while it plays) went silent at each wrap, about 100 ms in Chrome
  and 0.2-0.6 s in WebKit (measured 2026-11-10); two elements crossfaded
  at the seam came in 100-125 ms early in Chrome and left 170-450 ms
  silences in WebKit; and a seek of a playing element skips or repeats
  what lay between, which cut the click at the demo video's loop restart
  point. By ear in Safari, Chrome and the Mac app the loops kept a gap at
  every wrap (items 14 and 15). The player now plays every sound as an
  `AudioBufferSourceNode` on one `AudioContext`: a loop is the source's
  own `loop` from `loopStartSeconds` to the track's end, which the trial
  measured bit-exact in Chrome and WebKit, and volumes, fades and the
  duck are gain ramps on the context's clock (render/audio.ts).
- The bytes come from scripts. Under `file://` in Chrome, `fetch` of a
  sibling file fails and a media-element source outputs zeros (both
  measured), so Web Audio can read neither a file nor an element. A
  classic script loads under `file://`, so beside each audio file the
  folder ships `<file>.js`, which hands the player the file's bytes as
  base64 (docs/content-format.md, "The script beside each audio file"),
  and the player decodes them with `decodeAudioData`. The player reads
  only the scripts, so the folder `tools/assemble_folder.py` makes for
  play leaves the audio files out (docs/packaging.md).
- What it costs. A script is a third larger than its file, so a game's
  sound ships a third more bytes. A track plays from its whole decoded
  PCM, 4 bytes a sample on each channel at the context's rate: about
  23 MB a minute in stereo at 48 kHz, 69 MB for a 3-minute track.
  Decoded tracks stay in a least-recently-used cache under a 200 MiB cap
  (`DECODED_CAP_BYTES`, render/audiocache.ts), which never drops a track
  a sound holds; a track decodes when first wanted, and the warm-up
  decodes the next 3 items' tracks ahead (docs/perf.md, "Decode time").
- WebKit decodes AAC slowly at the file's own sample rate (a 3-minute
  stereo track 3.5-4.2 s, growing with the square of the length; 120-200
  ms at any other rate), and decodes one file at a time per context, so
  a short sound waited behind a long track. In WebKit each file decodes
  on an `OfflineAudioContext` of its own, and an AAC whose own rate is
  the context's decodes at twice that rate, with every second sample
  kept: about 0.19 s for that track, with the usual decode's length and
  first sample (item 22, render/audioload.ts). Other engines decode on
  the player's context.
- A video's own sound (`videoSound`) is the clock the video follows. Its
  buffer loops the video's range, from the restart point to the range
  end, and the video is sought to its restart point just before each
  wrap and onto its sound when the frames it shows stray more than 80 ms
  (item 19, render/audio.ts).
- The unlock: in a browser the player starts no sound until the reader's
  first key or click that counts as a user activation (not Esc, not a
  Cmd, Ctrl or Alt shortcut), whatever the engine allows. Chrome keeps
  the context suspended until then, but the WebKit driver with the key
  rule ran it on its own a few hundred ms after load in 4 runs of 12.
  That key resumes the context inside its handler and still does its own
  job.
  Until then, with sound on, a pill says "Press any key for sound". A
  page with a game app's host bridge (`window.kineticHost`) at load
  plays at launch, with no hint (render/audiorules.ts `soundUnlock`).
- The Mac app keeps `mediaTypesRequiringUserActionForPlayback = []`
  (`apps/macos/WebViewSetup.swift`), so its sound starts at launch with
  no hint.
- The Windows app passes Chromium's
  `--autoplay-policy=no-user-gesture-required` to WebView2 through the
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable, after any arguments
  the reader set there, whose own `--autoplay-policy` wins
  (`apps/windows/launch.go`), so its sound should start at launch too.
  Microsoft lists the flag but discourages browser flags in production
  apps. It is not verified on Windows; if WebView2 refuses a play anyway,
  the hint shows as in a browser.

## Content format decision

A directory of plain files with a `manifest.json`: an ordered list of items
(`image`, `animation` with frame list and fps, `video` with source and
poster), each with overlay text and speaker. The player and converter share
only this format, so both sides can be built and tested independently. The
full schema is a plan deliverable (Phase 2), written to
docs/content-format.md.

## Converter decisions

- Python 3.12 package with a CLI: input a Ren'Py project directory, output
  a content directory the player loads.
- Parsing: target `game/*.rpy` source directly with a small line/statement
  parser covering what kinetic novels use: `image`, `scene`, `show`,
  `hide`, `say` (character, text), `movie`, `stop movie`, and the
  story's flow from `label start` through `jump`, `call` and `return`
  (docs/extracting.md, "The walk follows labels"). Text format, ATL,
  transforms, and Python blocks are out of scope; report what was
  skipped.
- Compiled-only projects: vendor unrpyc (a standalone Python .rpyc
  decompiler by deceleration; take the current maintained repo at vendor
  time, pin the version) to decompile `*.rpyc` when no `.rpy` exists.
- Assets: Pillow to validate, resize when bytes demand it, and derive
  thumbnails; ffmpeg CLI for video (the measured rule, docs/plan.md
  Phase 26: by probed container, video codec and HEVC tag, never the
  name, a video Safari and Chrome both play ships byte-identical; H.264,
  HEVC or VP9 in a container one of them refuses is remuxed into MP4
  without re-encoding; any other codec is transcoded to H.264 MP4;
  posters and first frames). ffmpeg is a converter-only tool, never a runtime
  dependency.
- Reproducible media (docs/plan.md Phase 25, 2026-11-02): the converter
  uses only pinned tools, listed in `converter/media-tools.json`.
  Pillow, imagecodecs (libjxl, replacing a system `cjxl`/`djxl`) and
  numpy are pinned in requirements.txt; ffmpeg/ffprobe are static
  release builds (one version, a URL and archive sha256 per platform:
  Martin Riedl's for macOS arm64 and Linux arm64 and x86_64, Gyan
  Doshi's for Windows x86_64; no Intel Macs),
  installed by `tools/setup_media_tools.py` into the gitignored
  `.media-tools/<platform>/`, never looked up on PATH. Encoders run
  single-threaded and bitexact. A golden-hash self-test over committed
  samples runs at setup and (cached) at converter start; any missing
  install, version or binary drift, unpinned golden or mismatch makes
  the converter refuse to run. The goldens are shared by every
  platform, except that a platform may hold its own for the cases a
  CPU difference explains (`selftest.cpuDependent`, 2026-11-17: x86_64
  and arm64 differ there whoever built ffmpeg), so a folder's media is
  reproducible on the platform that made it: its ledger records that
  platform, and the reuse cache keys on it.
- Packaged assets: most released games keep all media inside `.rpa`
  archives; read those directly (a pickle index plus concatenated data,
  pure Python). Handle `.rpak` with an unrpak-style tool only when real
  input contains one. The converter test corpus and sampling rule are in
  docs/plan.md Phase 11.
- Converter tests: pytest over synthetic fixture projects checked into
  `fixtures/`, plus the golden `manifest.json` comparison.

## Distribution decision (confirmed with user 2025-10-31)

The double-clickable thing is a self-contained content folder, not an app
bundle: the converter writes the player (`index.html` + single `app.js`)
next to `manifest.js` and the media. Double-clicking `index.html` opens
the novel in the default browser, and the first keypress enters
fullscreen. No binary, no signing, and no gatekeeper prompt: locally
generated files carry no quarantine flag, and documents opened by the
browser never face a developer check. The `file://` constraints noted
above (classic script bundle, generated `manifest.js` shim, media via
relative tag loads) are what make this work; IndexedDB is available on
`file://` in Chrome and Safari.

Per-game apps (docs/plan.md Phase 43, the user, 2026-11-08) are now part
of distribution, built only when the author asks (CREATE.md, "Building
the apps"). The game is still a self-contained folder, and `index.html`
stays the route everywhere.

- macOS: `<title>.app` inside the game folder shows the folder through
  the system WebKit (WKWebView) with its own name and Dock icon,
  fullscreen from launch. It is arm64 only, needs macOS 12 or later and
  is signed ad hoc by `kinetic apps`, which copies in a host binary each
  release builds once and writes the game's settings into its
  Info.plist. It holds only its binary, so no check reads the media
  beside it.
- Windows: `<title>.exe` inside the game folder is a small Go program
  (x86-64, a GUI program, so no console window) that opens a window of
  its own and shows `index.html` in it through WebView2, the Edge engine
  Windows provides to apps, fullscreen from the start or as the window
  the reader left. Fullscreen is the window without its frame covering
  the monitor, so there is no fullscreen notice and every key is the
  game's (the user's choice, 2026-11-09, after an Edge app window showed
  Edge's notice and let a held Esc leave fullscreen; apps/README.md). It
  finds the installed WebView2 Runtime itself, with no loader DLL beside
  it, keeps the game's data in `%LOCALAPPDATA%\Kinetic\WebView2\<storyId>`,
  and opens `index.html` in the default browser where the runtime is
  missing. Microsoft preinstalls the runtime on all Windows 11 devices
  and installed it on all eligible Windows 10 devices
  ([Microsoft](https://learn.microsoft.com/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version#windows-11-devices-and-windows-10-devices)).
  Each release builds it once from Go's standard library (any system
  builds it), with its DPI manifest linked in, and `kinetic apps` writes
  each game's icon, version resource and settings into its copy's
  resources, on any system. It is unsigned.

Gatekeeper assesses only files that carry the quarantine flag. A folder
the author builds locally has none, so the app opens with no check. A
folder downloaded as a zip is quarantined: its ad-hoc signed app is then
refused, and App Translocation would run it away from its folder, so
readers of a download use `index.html` or clear the flag. The first time
the app opens from Documents, Desktop or Downloads, macOS asks once for
access to that folder. An ad-hoc signature changes with every build, so
a rebuilt app asks again.

On Windows, SmartScreen checks only files that carry the Mark of the
Web. A folder the author builds locally has none, so the exe starts with
no prompt. A downloaded zip carries the mark, and extracting it with
Windows passes the mark to the exe, whose first run then asks the
reader to confirm (More info, Run anyway).

## Voice install decision (Phase 52, the user, 2026-11-15)

A Kinetic game app can speak a game's lines, generated on the reader's
machine (docs/plan.md Phase 52; docs/voice-reading.md has the research).
That needs a speech model, a Python and some libraries, none of which a
game folder can carry, so the voice install is the one opt-in download a
Kinetic app makes.

- What it fetches: a private Python (python-build-standalone), the pinned
  packages, and the model files at pinned revisions, all checked by
  sha256, into one per-machine folder shared by every Kinetic app
  (`~/Library/Application Support/Kinetic/Voice/` on a Mac,
  `%LOCALAPPDATA%\Kinetic\Voice\` on Windows). Nothing is fetched or
  written there until the reader presses Download voice model in the
  Volumes box (offered only for a game with a line that needs the model),
  and Remove voice model deletes all of it. The sources are
  python-build-standalone's GitHub releases, PyPI and Hugging Face.
- Why a game folder still needs no network at play time: the rule is
  about the folder. A folder, with or without voices, plays from its own
  files over `file://`, silently where there is no voice engine, and a
  browser never downloads anything. Only the app, and only after the
  reader's opt-in, reaches the network, and the folder itself carries no
  model: its voices are reference clips (docs/packaging.md).
- The helper is a separate process. `apps/voice/kinetic_voice` is Python
  that the app embeds in its binary and writes into the voice folder, so
  the app bundle keeps its layout. The app runs it with the private
  Python and talks to it in JSON lines on its stdin and stdout: no network
  port, so no firewall prompt, and a crash cannot take the game down (the
  app restarts it). The page reaches it through the host bridge
  (apps/README.md, "Spoken lines").
- The engine is Chatterbox multilingual v3 (MIT), cloned from each
  character's reference clip, on MLX on a Mac (Apple silicon, macOS 14 or
  later). The Windows app runs the same helper with a PyTorch backend, on
  an NVIDIA GPU (CUDA), and only there: a Windows PC with no NVIDIA card
  or an old driver is offered no download (the CPU was too slow); that is
  in progress.
  The browser's own speech was rejected (no per-character voices).

## Revisit triggers

- User later wants a real .app: superseded by the per-game apps in the
  Distribution decision above (a Swift WebKit host on macOS, built with
  Xcode or the Command Line Tools), so no Tauri packaging phase and no
  Rust.
- Measured navigation p95 above 41 ms on real content: revisit bitmap
  counts, tiling, or a WebGL presenter before touching anything else.
- A real Ren'Py input needs constructs beyond the parse subset: extend the
  converter scope deliberately in Phase 11, do not grow the parser ad hoc.
