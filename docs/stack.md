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

Settled in docs/plan.md Phase 47 (the user, 2026-11-09). Sound is
optional: a manifest without `audio` plays and validates as before
(docs/content-format.md, "Audio").

- Formats (media rule b): keep what Chrome and WebKit both play and time
  right, which is MP3, AAC in M4A, PCM WAV, FLAC, and Vorbis or Opus in
  WebM. Vorbis or Opus in Ogg is copied into WebM without re-encoding,
  and anything else is re-encoded to Opus in WebM. In WebKit an Ogg file
  misreports its duration and its clock runs 4-7% slow, Chrome plays it
  0.8 s past its end, and Safari plays Ogg only from 18.4 (macOS 15.4).
  The same stream in WebM is right in both engines, and Safari has played
  Vorbis and Opus in WebM since 15-17.4, inside the Safari 17 baseline
  JPEG XL already sets. The measurements and the full table are in
  docs/extracting.md, "Audio policy".
- HTMLAudioElement only. Under `file://` in Chrome, Web Audio fed from a
  media element outputs zeros, and `fetch` of a sibling file fails, so
  Web Audio cannot decode the files either (both measured). Embedding the
  bytes in a script would add a third to the file size, plus about 69 MB
  of decoded PCM for a 3-minute stereo track.
- Loops: an element that loops on its own (its `loop`, or a seek while it
  plays) goes silent at each wrap, about 100 ms in Chrome and 0.2-0.6 s in
  WebKit, whose own loop can also stop for good at the end of an Opus WebM
  or a WAV (measured 2026-11-10). So each music and ambience loop has two
  elements that trade places at its end, the waiting one started its
  learnt lead early (render/audio.ts). A wrap then lands on the engine's
  output block nearest the end: 10.7 ms blocks in headless Chrome, 85 ms
  in the muted WebKit driver; real output is not measured.
- A video's own sound (`videoSound`) has two elements too, and the one
  playing is never sought: a seek of a playing element skips or repeats
  what lay between, which lost the click at the demo's loop restart point
  at every wrap. The waiting one starts its learnt lead before the video
  gets where it waits (its restart point before a wrap) and takes over
  then. A video starting from paused (an entry, a menu's resume) waits
  for its sound, about 0.3 s in the WebKit driver and 25 ms in Chrome.
  The WebKit driver begins every sound on its 85 ms output grid, so a
  start takes its least time up to one block more. Once starts show the
  grid, a play at the same point of a block as a measured start takes as
  long as it did: each start is played to sound on the block end nearest
  its moment, within half a block, and a video's start from paused waits
  for the moment its sound is known to begin. Only starts heard at full
  volume teach this: WebKit runs the clock of an element at volume 0.001
  from about 60 ms, without waiting for its sound (render/audio.ts).
- The unlock: a browser refuses `play()` until the reader's first key or
  click that counts as an activation (not Esc, not a Cmd, Ctrl or Alt
  shortcut). The player starts every element the game needs inside that
  handler, since WebKit then lets an element play for good but refuses
  one first played seconds later. Until then a pill says "Press any key
  for sound".
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
  `hide`, `say` (character, text), `movie`, `stop movie`, and simple
  `label`/`jump` linear flow. Text format, ATL, transforms, and Python
  blocks are out of scope; report what was skipped.
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
  numpy are pinned in requirements.txt; ffmpeg/ffprobe are Martin
  Riedl's static release builds (one version, a timestamped URL and
  archive sha256 per platform: macOS and Linux, arm64 and x86_64),
  installed by `tools/setup_media_tools.py` into the gitignored
  `.media-tools/<platform>/`, never looked up on PATH. Encoders run
  single-threaded and bitexact. A golden-hash self-test over committed
  samples runs at setup and (cached) at converter start; any missing
  install, version or binary drift, unpinned golden or mismatch makes
  the converter refuse to run.
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
  is signed ad hoc by `tools/build_apps.py`. It holds only its binary,
  so no check reads the media beside it.
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
  `tools/build_apps.py` builds it from Go's standard library on any
  system and links in its icon, version resource and DPI manifest. It is
  unsigned.

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

## Revisit triggers

- User later wants a real .app: superseded by the per-game apps in the
  Distribution decision above (a Swift WebKit host on macOS, built with
  Xcode or the Command Line Tools), so no Tauri packaging phase and no
  Rust.
- Measured navigation p95 above 41 ms on real content: revisit bitmap
  counts, tiling, or a WebGL presenter before touching anything else.
- A real Ren'Py input needs constructs beyond the parse subset: extend the
  converter scope deliberately in Phase 11, do not grow the parser ad hoc.
