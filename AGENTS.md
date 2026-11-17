# Agent Notes

Working rules for agents in this repo. Read docs/plan.md for the phase you
are implementing and docs/stack.md for settled decisions.

## Commands

- Player: from `player/`: `npm test`, `npm run check`, `npm run build`,
  `npm run dev`. `npm run i18n` rewrites `player/locales/messages.pot`,
  `src/i18n/locales.generated.ts` and `apps/host-words.json` (the game
  apps' own words) from the English catalogue and
  the PO files (`npm run build` runs it; `npm test` fails while they
  are stale; docs/verify-player.md, "The player's words").
- Python tools/fixtures/validator: `.venv/bin/python` from the repo root;
  deps pinned in `requirements.txt`. Create the venv with
  `python3 -m venv .venv && .venv/bin/pip install -r requirements.txt` if
  missing.
- Converter: editable install once per venv:
  `.venv/bin/pip install -e ./converter --cache .tmp/pip-cache`; then
  the pinned media tools once per checkout:
  `.venv/bin/python tools/setup_media_tools.py` (downloads the static
  ffmpeg/ffprobe named in `converter/media-tools.json` into the
  gitignored `.media-tools/<platform>/` and runs the golden-hash
  self-test; `--pin` records null checksums and goldens). Only the
  orchestrator, not a subagent, records pins: a platform's archive
  checksums only by running `--pin` on that platform, only when the
  download matches the publisher's checksum and only while every
  shared golden matches; the golden of a newly added self-test case
  with `--repin CASE` from the installed pinned tools while every other
  case still matches; and it lists every hash recorded in the item's
  evidence note. Run `.venv/bin/kinetic-extract
  <renpy_project> <out>`; it refuses to start until that setup has
  passed. Tests
  `.venv/bin/pytest converter/ tools/ -q -n auto` (pytest-xdist, one
  worker per core, about 45 s; a single file runs fine without `-n`).
- `--version` on `kinetic-extract`, `kinetic-media`, `tools/`
  `validate_content.py`, `assemble_folder.py`, `build_apps.py`,
  `setup_media_tools.py`, `upgrade_folder.py` and `translations.py`, and
  `check-game.mjs`
  prints `Kinetic <VERSION>` and exits, needing no media tools. A built
  `app.js` opens with `/*! Kinetic <version> */`; read a folder's with
  `kinetic_extract.version.folder_player_version` (Python) or
  `folderKineticVersion` in `player/scripts/version.mjs` (null/None for
  an older player).
- Game apps: `.venv/bin/python tools/build_apps.py <game-folder> [--mac]
  [--windows] [--icon IMAGE]` adds `<title>.app` (needs macOS and a
  Swift toolchain) and `<title>.exe` (needs Go 1.27 or later, any OS;
  Go's caches go to `.tmp/windows-app-build/`);
  `tools/assemble_folder.py` takes the same flags (CREATE.md, "Building
  the apps"). The exe's Go tests, from `apps/windows/`:
  `GOCACHE=$PWD/../../.tmp/windows-app-build/go-cache GOTOOLCHAIN=local
  go test ./...` (and `GOOS=windows go vet ./...` with the same
  variables); the host script test runs the script in Node and skips
  without it. Never launch a built app on the user's screen unasked.
- Translations as PO files: `.venv/bin/python tools/translations.py
  export <folder> TAG [--out FILE]`, `import <folder> FILE.po`, `status
  <folder>` (docs/translating.md); tests
  `.venv/bin/pytest tools/test_translations.py
  converter/tests/test_po.py -q -n auto`.
- Upgrade a game folder's player: `.venv/bin/python
  tools/upgrade_folder.py <folder>` after `npm run build` (refuses a
  stale `player/dist/`; CREATE.md, "Upgrading to a newer Kinetic").
- Media only, no story parse: `.venv/bin/kinetic-media ship <game_root>
  <out> --list requests.json` (format: docs/extracting.md). Both
  `ship` and `rebuild` take `--jobs N` (default: one per core) and
  `--video-jobs N` (default: a quarter of that); `--jobs 1` is the
  serial path, same output. Progress goes to stderr every 10 s.
- Verify or reproduce a folder's media from its ledger and the original
  files: `.venv/bin/kinetic-media rebuild <game_root> <folder>
  [--decoder MODULE:FUNC ...] [--out DIR]` (exit 0 only when every hash
  matches).
- Check that each video item's poster is the frame at its
  `startSeconds`: `.venv/bin/kinetic-media posters <game_root> <folder>
  [--manifest FILE] [--items FILE]` (writes nothing; exit 1 lists the
  wrong ones; `--items` limits it to listed ids);
  `--fix --remap FILE` ships the right ones and writes item id -> new
  poster for the caller to apply (docs/extracting.md, "kinetic-media
  posters").
- Step-by-step use of all of this (decoder hooks, a game-specific helper
  shipping per episode, rebuild on another machine, troubleshooting):
  CREATE.md, "Converting a Ren'Py project".
- Encodes are cached in `.tmp/kinetic-media-cache/` (re-runs encode
  nothing); `KINETIC_MEDIA_CACHE=DIR` moves it, `=off` disables it.
  Tests get a fresh one per test (`converter/tests/conftest.py`).
- Converter tests point `KINETIC_MEDIA_TOOLS_DIR` (test-only, set by
  `converter/tests/conftest.py`) at the system ffmpeg; never set it for a
  real conversion. The converter never uses PATH's ffmpeg, `cjxl` or
  `djxl`.
- Play a built game folder with no window (WebKit or headless Chrome):
  `node player/scripts/testing/check-game.mjs <folder> [--engine
  webkit|chrome] [--steps N|all] [--start-at ID] [--until ID]
  [--no-media-check] [--trace FILE] [--lang TAG]` (any walk stops at
  the story's end; a video segment step prints as its own step ending
  `view n of m`; `--until` walks as `--steps all` unless `--steps` is
  given and reports its span from the start; `--no-media-check` skips
  the media check after the walk; `--trace FILE` writes the player's
  item trace, every item, choice and end record of the walk, to FILE as
  JSON lines; `--lang TAG` walks with that game language shown and
  reports the fallback and stale lines met; exit 0 passed, 1 errors, a
  stuck player, the `all` cap, `--until` not reached, a stalled media
  check, a player too old to trace or a game opened in another language
  than `--lang`, 2 bad arguments (a bad `--engine`, an unwritable
  `--trace` FILE or a `--lang` the game lacks too), 3 a walk from the
  opening reached the end with items never shown, or a span with items
  not shown; 1 wins over 3), or a script using `openGame` from
  `player/scripts/testing/kinetic.mjs` (`trace: true` and the handle's
  `trace()` read the same trace; `language: TAG` as `--lang`; CREATE.md,
  "Testing your game"); never hand-roll puppeteer against
  `player/node_modules`.
- Automated browsers make no sound: Chrome starts only through
  `launchChrome` in `player/scripts/testing/core.mjs`
  (`--disable-audio-output`; biome blocks other `puppeteer-core`
  imports), the WebKit driver mutes its page, and that file's key helpers
  give Chrome no native key code except for Escape, so an unhandled key
  cannot beep. Both launchers give every page the test sound flag
  (`player/scripts/testing/testaudio.mjs`), so the player holds its Web
  Audio master gain at 0: the WebKit page mute is not shown to silence
  Web Audio. The driver allows sound with no key, as the macOS app does;
  `requireGestureForAudio: true` (`launchBrowser`, or a scenario's
  `open`) passes it `--require-gesture-for-audio`, so it waits for a key
  as Safari does. Headless Chrome always waits.
- `fixtures/demo` and `fixtures/audio-demo` are gitignored builds:
  `.venv/bin/python fixtures/build_demo.py` and
  `.venv/bin/python fixtures/build_audio_demo.py` (both need PATH
  ffmpeg). Scenario parts on the audio demo FAIL with that hint when it
  is missing.
- Perf, from `player/` after `npm run build` (docs/perf.md): `npm run
  perf` (navigation p95 in Chrome, and decoded audio held; `-- DIR...
  [--start ID]` walks other folders), `perf:map`, `perf:save`,
  `perf:sound` (target sound in Node; `-- --folder DIR` writes its
  160,000-item story as a game folder for `perf`), and `perf:decode`
  (track decode time and result in WebKit and Chrome; needs PATH ffmpeg,
  no build).
- Spoken lines (docs/plan.md Phase 52): the helper's tests,
  `.venv/bin/pytest apps/voice/tests -q -n auto` (a fake engine; no
  model). The casting tool needs its own venv, made once:
  `python3 -m venv .venv-voice && .venv-voice/bin/pip install --no-deps
  --only-binary :all: -r requirements-voice.txt --cache .tmp/pip-cache`
  (gitignored); `.venv/bin/python tools/cast_voices.py design|pick|record`
  (`design` runs the real model: about 4.5 GB downloaded once, Apple
  silicon; its test, `.venv/bin/pytest tools/test_cast_voices.py -q`, uses
  a fake generator). The voice demo:
  `.venv/bin/python fixtures/build_voice_demo.py` (gitignored output;
  needs no ffmpeg; its test is `tools/test_build_voice_demo.py`). Scenario
  files: `spoken` (Chrome and WebKit, against the stand-in host
  `player/scripts/testing/fakevoice.mjs`) and `machost` (WebKit only, the
  Mac host's VoiceEngine with a fake helper), e.g. `npm run verify --
  --webkit spoken machost`. `KINETIC_VOICE_DIR`, `_DOWNLOAD_BASE`, `_LOCK`,
  `_PYTHON` and `_HELPER` are test-only overrides of the Mac host
  (`apps/README.md`, "Spoken lines"); never set them for a real run, and
  never install the real voice into the user's own voice folder from a
  test. Recording a game's lines with the helper (Phase 52 item 13):
  `.venv/bin/python tools/record_lines.py <game-folder> [--voice-dir DIR]
  [--bitrate KBPS] [--dry-run]` (needs the pinned media tools; installs
  the machine's voice folder when missing, so give it `--voice-dir` with
  a `.tmp` install; its test, `.venv/bin/pytest tools/test_record_lines.py
  -q`, drives the helper's fake engine).
- ffmpeg and macOS `sips` are on PATH (fixture builders use them); there
  is no Rust toolchain.

## Sandbox gotchas

- `npm install` fails writing `~/.npm`; add `--cache ../.tmp/npm-cache`
  (from `player/`) or `--cache .tmp/npm-cache` (from root).
- No sudo, no system package installs, writes stay inside the repo
  (`.tmp/` and `.venv/` are gitignored and available).
- Headless Chrome for `file://` checks:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  --headless=new --no-sandbox --disable-gpu --disable-audio-output
  --disable-crash-reporter
  --crash-dumps-dir=$PWD/.tmp/crashdumps --user-data-dir=$PWD/.tmp/
  chrome-profile --enable-logging=stderr --v=1 --dump-dom <file-url>`;
  grep stderr for `CONSOLE` to find page errors.
- The Ren'Py corpus at /Volumes/Data/games is read-only reference data;
  never modify it.

## Test speed (orchestrator directive, 2026-11-01)

Per checklist item, run only what the item can break:

- Always: `npm test` and `npm run check` from `player/` (seconds).
- Browser-visible change: `npm run verify -- --smoke` (builds, then a
  ~5 s check per area) plus the matching scenario file(s):
  `npm run verify -- <name>` (e.g. `branches`) runs only the scenario
  files whose name matches. Scenarios live in
  `player/scripts/scenarios/*.scenario.mjs`, each on a fresh browser
  profile, so one never depends on another. The runner runs files and
  their independent `parts` side by side, 4 at a time (`--jobs=N` or
  `KINETIC_SCENARIO_JOBS` changes it: `--jobs=8` on a quiet machine,
  `--jobs=1` is serial); the full suite takes about 2 minutes. Set
  `KINETIC_SCENARIO_ROOT=../.tmp/scenarios-<x>` when runs may overlap.
  Each file or part has a wall-clock limit (FAIL, Chrome killed, run
  continues); `KINETIC_SCENARIO_TIMEOUT_MS` overrides the default.
- Sound change: the scenario files `audio` and `videosound`, and
  `screens` for the sound controls.
- Rendering, input, fullscreen, media, sound or the macOS host
  (`apps/macos/`): also run those scenario files on WebKit,
  `npm run verify -- --webkit <name>` (docs/verify-player.md, "WebKit").
- Python change: `pytest` on the touched test file only.
- The full suite (`npm run verify` and `npm run verify -- --webkit` with
  no filter, full pytest, `package-proof`) runs ONCE when the current
  phase is believed complete, before its closing commit.

## Workflow

Every user request for a fix or feature becomes a checklist item in
docs/progress.md, implemented by a fresh-context subagent. The
orchestrator writes the item, briefs the subagent, verifies the result
itself (the test-speed rules above), ticks the item with an evidence
note, then commits and pushes before starting the next item. The
orchestrator does not implement items inline.

Unscheduled features, requested or maybe, are entries in docs/future.md.
When the user schedules one, settle its "To settle" list with them, plan
it as a docs/plan.md phase, and remove its entry.

Versions: `VERSION` at the repo root is Kinetic's version; `version` in
`player/package.json` (and its lockfile) and `converter/pyproject.toml`
(PEP 440: `1.8.0-dev` is `1.8.0.dev0`) agree with it, which
`tools/test_release_version.py` enforces. Each phase's planning commit
sets the next `X.Y.Z-dev`. Its closing commit sets the release number
(patch: fixes only; minor: a feature or a new optional manifest field;
major: a change that stops existing folders or saves working, the only
time `schemaVersion` moves), dates the CHANGELOG entry, tags `vX.Y.Z`
and fast-forwards `main`. After changing `VERSION`, rerun the converter's
editable install so its package metadata matches (the version test
reads it).

## Git

Subagents do not run git add/commit/push and never edit docs/progress.md;
the orchestrator verifies each checklist item, commits and pushes.

Commit messages describe the change. The subject is `area: what
changed`, about 72 characters or fewer, naming the phase and item when
there is one. The area is the part of the repo changed: player,
converter, tools, format, fixtures, voice, macos, windows, tests or
docs (two joined by a comma). Add a body only when the reason or the
shape of the change needs saying, and describe the change there too.
Test counts, verify results, load averages and other run evidence go
in the item's evidence note in docs/progress.md. Planning and closing
commits follow the same rule; the closer's subject is the release.

- Planning: `docs: plan Phase 55, reliable WebKit map checks`
- Closing: `release 1.10.1`
- Good: `player: Phase 54 item 1, test-only item trace`
- Bad: `docs: Phase 54 closed, release 1.10.0 (full pytest 1241, verify
  794/794 Chrome, ...)`, which records the run, not the change.

Earlier commits keep their messages; history is not rewritten.
