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
  t (bookmark list), e (jump to next unseen), c (config). Scroll wheel
  rolls time back and forward.
- Navigation latency under 1/24 s (41 ms). Pre-decode and pre-size are the
  mechanisms; runtime video decode must never gate a navigation.
- macOS, no runtime dependencies except browser-related stuff, no
  gatekeeper friction (no binary, or a tiny one).
- No audio, no menus, always fullscreen.
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
| Tauri v2 | Deferred | ~5 MB Rust binary over system WKWebView; the best native story, and v2 is current (verified at v2.tauri.app). Needs a Rust install this machine lacks, plus two toolchains to operate. Kept as an optional packaging phase. |
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
  Muted autoplay is exempt from browser autoplay policies, and Kinetic has
  no audio anyway, so videos play without special handling.
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
  progress. Moving to another browser is an explicit Export / Import of
  a per-story JSON file on the Esc screen. No server, no
  files-from-browser problem.

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
  thumbnails; ffmpeg CLI for video (MP4/MOV H.264/HEVC and WebM
  VP8/VP9/AV1 kept native, anything else transcoded to H.264 MP4; MKV
  copied unchanged whatever the codec, with a warning when no target
  browser plays its video codec (docs/plan.md Phase 25); posters and
  first frames). ffmpeg is a converter-only tool, never a runtime
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

## Revisit triggers

- User later wants a real .app (own icon in Applications, Spotlight
  results): add a Tauri packaging phase (needs `rustup` installed by the
  user; nothing in the app changes, Tauri wraps the same static files).
- Measured navigation p95 above 41 ms on real content: revisit bitmap
  counts, tiling, or a WebGL presenter before touching anything else.
- A real Ren'Py input needs constructs beyond the parse subset: extend the
  converter scope deliberately in Phase 11, do not grow the parser ad hoc.
