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
- Converter and `kinetic`: editable install once per venv:
  `.venv/bin/pip install -e ./converter --cache .tmp/pip-cache`; then
  the pinned media tools once per checkout: `.venv/bin/kinetic setup`
  (downloads the static ffmpeg/ffprobe named in
  `converter/media-tools.json` into the gitignored
  `.media-tools/<platform>/` and runs the golden-hash self-test;
  `--pin` records null checksums and goldens). Only the
  orchestrator, not a subagent, records pins: a platform's archive
  checksums only by running `--pin` on that platform, only when the
  download matches the publisher's checksum and only while every
  shared golden matches, except that the same `--pin` may record the
  platform's own goldens for cases in `selftest.cpuDependent` (setup
  refuses any other difference; only the user extends that list); the
  golden of a newly added self-test case
  with `--repin CASE` from the installed pinned tools while every other
  case still matches; and it lists every hash recorded in the item's
  evidence note. Run `.venv/bin/kinetic extract
  <renpy_project> <out>`; it refuses to start until that setup has
  passed. Tests
  `.venv/bin/pytest converter/ tools/ -q -n auto` (pytest-xdist, one
  worker per core, about 45 s; a single file runs fine without `-n`).
- `kinetic` is the one command for the tools (distribution name
  `kinetic`; a venv that still has the old `kinetic-extract` needs
  `.venv/bin/pip uninstall kinetic-extract` before reinstalling):
  subcommands `setup`, `extract`, `media`, `validate`, `assemble`,
  `apps`, `upgrade`, `check`, `report`, `routes`, `export`,
  `release-status`, each taking the arguments of the tool it wraps
  (`kinetic_extract/kinetic_cli.py`, `tool_commands.py`). The old
  names still work: `kinetic-extract`,
  `kinetic-media`, and `tools/validate_content.py`,
  `assemble_folder.py`, `upgrade_folder.py`, `setup_media_tools.py` and
  `build_apps.py`, wrappers over the modules in
  `converter/kinetic_extract/`. File locations go through
  `kinetic_extract/paths.py`: a checkout reads and writes the repo as
  always, an installed wheel uses package data and `KINETIC_HOME` or the
  per-user folders (docs/packaging.md, "Installing the tools"). The
  wheel: `.venv/bin/python tools/build_wheel.py [--out DIR]` (fresh
  player build into a staging folder, the testing library and
  check-game bundled with the WebKit driver by
  `player/scripts/bundle-check.mjs --driver`, the two app hosts, the
  release's progress.md and CHANGELOG.md with its commit; needs Swift
  and Go; writes
  `dist/kinetic-<version>-py3-none-any.whl`); its test,
  `.venv/bin/pytest tools/test_build_wheel.py -q`, installs it into a
  venv under `.tmp/` and runs the commands outside the repo, `kinetic
  apps` with no Swift or Go on PATH (about a minute).
- `--version` on `kinetic`, `kinetic-extract`, `kinetic-media`, `tools/`
  `validate_content.py`, `assemble_folder.py`, `build_apps.py`,
  `setup_media_tools.py`, `upgrade_folder.py`, `translations.py`,
  `build_wheel.py` and `publish_demo.py`, and `check-game.mjs`
  prints `Kinetic <VERSION>` and exits, needing no media tools. A built
  `app.js` opens with `/*! Kinetic <version> */`; read a folder's with
  `kinetic_extract.version.folder_player_version` (Python) or
  `folderKineticVersion` in `player/scripts/version.mjs` (null/None for
  an older player).
- Game apps: `.venv/bin/kinetic apps <game-folder> [--mac] [--windows]
  [--icon IMAGE]` copies the prebuilt hosts in as `<title>.app` (signed
  with `codesign`, so macOS only) and `<title>.exe` (any OS; its
  resources rewritten) with the game's settings; `kinetic assemble`
  takes the same flags (CREATE.md, "Building the apps"). In a checkout
  the hosts are built on first use into `.tmp/app-hosts/<kind>-<hash>/`
  (`converter/kinetic_extract/app_hosts.py`): the Mac host needs a Swift
  toolchain, the exe Go 1.27 or later (Go's caches in
  `.tmp/windows-app-build/`); an installed wheel carries both. Each host
  answers `--self-check FILE` (its settings as JSON, no window;
  apps/README.md, "Game settings"): the Mac binary is
  `<title>.app/Contents/MacOS/kinetic`. The exe's Go tests, from
  `apps/windows/`: `GOCACHE=$PWD/../../.tmp/windows-app-build/go-cache
  GOTOOLCHAIN=local go test ./...` (and `GOOS=windows go vet ./...` with
  the same variables); the host script test runs the script in Node and
  skips without it. The Mac host's settings tests are
  `apps/macos/tests/main.swift`, which `tools/test_build_apps.py`
  compiles and runs. Never launch a built app on the user's screen
  unasked; `--self-check` opens none.
- Translations as PO files: `.venv/bin/python tools/translations.py
  export <folder> TAG [--out FILE]`, `import <folder> FILE.po`, `status
  <folder>` (docs/translating.md); tests
  `.venv/bin/pytest tools/test_translations.py
  converter/tests/test_po.py -q -n auto`.
- Assemble and validate: `.venv/bin/kinetic assemble <content> <out>`,
  `.venv/bin/kinetic validate <folder> [--ledger FILE] [--strict]
  [--json]` (silent and exit 0 when clean, languages included; problems
  on stdout, exit 1; warnings on stderr with a count per kind, exit 0,
  or 3 with `--strict`; 2 bad arguments; `--json` prints problems,
  warnings by kind, per-language coverage and `exitStatus` as one
  object; CREATE.md, "Validating"). Upgrade a game folder's player:
  `.venv/bin/kinetic upgrade <folder> [--to NEW] [--dry-run]` after
  `npm run build` (refuses a stale `player/dist/`; `--to NEW` upgrades
  a new copy on the same volume, media hard-linked, the rest copied, the
  folder only read; `--dry-run` prints what it would replace and
  validates the folder as it is, writing nothing; CREATE.md, "Upgrading
  to a newer Kinetic"). `.venv/bin/kinetic release-status [--json]`
  prints the version, the commit built from (`-dirty` when not clean),
  progress.md's checked and open boxes and the version's CHANGELOG
  entry, from the wheel's copies or a checkout's files and git (exit 0
  whenever it ran, 1 an older wheel without them, 2 bad arguments).
- The demo on GitHub Pages (https://sendub.github.io/kinetic/):
  `.venv/bin/python tools/publish_demo.py [--dry-run] [--out DIR]`
  builds the player and fixtures/demo afresh, assembles them into a site
  folder (default `.tmp/publish-demo/site/`) and replaces the `gh-pages`
  branch with one parentless commit of it, pushed as this checkout
  pushes; it refuses changed or untracked files under `VERSION`,
  `LICENSE`, `player/` or `fixtures/` (its docstring lists the
  exclusions). `--dry-run` builds and stops. Its test,
  `.venv/bin/pytest tools/test_publish_demo.py -q`, pushes only to a
  throwaway repo. check-game's `--http` (openGame's `http`) plays a
  folder served from 127.0.0.1, as a web host serves it, and `--url
  https://sendub.github.io/kinetic/` with the site folder walks the
  live copy.
- Media only, no story parse: `.venv/bin/kinetic media ship <game_root>
  <out> --list requests.json` (format: docs/extracting.md). Both
  `ship` and `rebuild` take `--jobs N` (default: one per core) and
  `--video-jobs N` (default: a quarter of that); `--jobs 1` is the
  serial path, same output. Progress goes to stderr every 10 s.
- Verify or reproduce a folder's media from its ledger and the original
  files: `.venv/bin/kinetic media rebuild <game_root> <folder>
  [--decoder MODULE:FUNC ...] [--out DIR]` (exit 0 only when every hash
  matches).
- Check that each video item's poster is the frame at its
  `startSeconds`: `.venv/bin/kinetic media posters <game_root> <folder>
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
  `.venv/bin/kinetic check <folder> [--engine webkit|chrome] [--steps
  N|all] [--start-at ID] [--until ID] [--no-media-check] [--trace FILE]
  [--lang TAG]` (any walk stops at the story's end; a video segment step
  prints as its own step ending `view n of m`; `--until` walks as
  `--steps all` unless `--steps` is given and reports its span from the
  start; `--no-media-check` skips the media check after the walk;
  `--trace FILE` writes the player's item trace, every item, choice and
  end record of the walk, to FILE as JSON lines; `--lang TAG` walks with
  that game language shown and reports the fallback and stale lines met;
  a line that overflows the screen or its column at the folder's size
  prints a warning, with no change to the exit code; exit 0 passed, 1
  errors, a stuck player, the `all` cap, `--until` not reached, a
  stalled media check, a player too old to trace or a game opened in
  another language than `--lang`, 2 bad arguments (a bad `--engine`, an
  unwritable `--trace` FILE or a `--lang` the game lacks too), 3 a walk
  from the opening reached the end with items never shown, or a span
  with items not shown; 1 wins over 3; it runs `node
  player/scripts/testing/check-game.mjs`, which takes the same
  arguments), or a script using `openGame` from
  `player/scripts/testing/kinetic.mjs` (`trace: true` and the handle's
  `trace()` read the same trace; `language: TAG` as `--lang`;
  `savedState: RECORD` writes a state record under the story's key
  before the first load, and the handle's `storageKey` and
  `savedState()` read the key and the record back; CREATE.md, "Testing
  your game"); never hand-roll puppeteer against
  `player/node_modules`. `kinetic check --library` prints the path a
  script imports (in a checkout that file; in a wheel its bundle,
  `kinetic_extract/data/check/kinetic.mjs`, puppeteer-core inside), with
  no Node.
- `KINETIC_TEST_SYSTEM_LANGUAGES=TAG,...` (test-only,
  `player/scripts/testing/core.mjs`) makes launched browsers start as
  on a Mac with those system languages; never set it for a real check.
  `KINETIC_SCRATCH_DIR` moves the testing library's scratch folder
  (fresh Chrome profiles, crash dumps; default a checkout's `.tmp/`,
  else the per-user cache's `check/`; `testing/scratch.mjs`).
- Report on a game folder for an agent, with no browser:
  `.venv/bin/kinetic report <folder> [--json]` (reading time per route
  by the Timing hold rule, speakers with line counts and look-alike
  names, `characters` and transition counts, text tag problems, files
  nothing references, the 20 longest lines, each language's
  translation coverage; exit 0 whenever it ran, 2
  bad arguments or no readable manifest; CREATE.md, "Checking a
  conversion: kinetic report"). `kinetic routes <folder> [--dot |
  --json]` prints the branch structure as the branch map draws it
  (decisions, routes, where each ends or rejoins);
  `fixtures/route-shapes.json` holds it and mapmodel.ts to the same
  counts. `kinetic export <folder> [--lang TAG] [--out DIR]` prints the
  story as Markdown, the main line and each route, to lay beside the
  `.rpy` source. Both exit as report does.
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
- README screenshots, from `player/` after `npm run build`: `npm run
  screenshots` reads `fixtures/showcase-demo` in headless Chrome and
  rewrites `docs/images/*.png` (reading, Esc screen, branch map,
  bookmarks). That story is a gitignored build, `.venv/bin/python
  fixtures/build_showcase_demo.py` (no ffmpeg; its test is
  `tools/test_build_showcase_demo.py`).
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
  no filter, full pytest, `package-proof`, whose wheel stage builds the
  wheel and runs the installed `kinetic` on the extract demo, after
  `.venv/bin/kinetic extract fixtures/renpy_demo .tmp/extract-demo`
  when that is missing) runs ONCE when the current phase is believed
  complete, before its closing commit.

## Workflow

Every user request for a fix or feature becomes a checklist item in
docs/progress.md, implemented by a fresh-context subagent. The
orchestrator writes the item, briefs the subagent, verifies the result
itself (the test-speed rules above), ticks the item with an evidence
note, then commits and pushes before starting the next item. The
orchestrator does not implement items inline.

Phase work runs without stopping (the user, 2026-11-20). Planning
still settles the design questions with the user first, one at a time,
before the phase is written. Once the phase is planned and committed,
the orchestrator's question is "Start phase?", not "Start item 1?". On
a yes it works the items in order, one after another, until only the
phase-closer is left:

- A question that comes up mid-phase gets the sensible answer at once,
  recorded in the item's evidence note, and the work continues. Leads
  become items of the phase, as always.
- Before the closer, it stops once: it lists every decision it took
  that way, each with the answer it chose, and asks the user to check
  a demo of the phase's changes, naming what to try and how. Anything
  the user changes becomes an item before the closer.
- After the closer, its report ends with a message for a converting
  agent working on a Kinetic game, ready to pass on: what changed in
  the release, what to do to take advantage of it, and any upgrade
  step. It names no game.

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
and fast-forwards `main`. After pushing the tag it builds the wheel and
creates the GitHub release with the wheel attached and the CHANGELOG
entry as its notes, with the `sendub` account (X.Y.Z the release):

```sh
.venv/bin/python tools/build_wheel.py
awk '/^## X.Y.Z /{f=1;next} /^## /{f=0} f' CHANGELOG.md > .tmp/release-notes.md
GH_TOKEN=$(gh auth token --user sendub) gh release create vX.Y.Z \
  dist/kinetic-X.Y.Z-py3-none-any.whl --repo sendub/kinetic --verify-tag \
  --title "Kinetic X.Y.Z" --notes-file .tmp/release-notes.md
```

Then it republishes the demo with `.venv/bin/python
tools/publish_demo.py` (from the clean release commit), so the site
plays the release.

After changing `VERSION`, rerun the converter's editable install so its
package metadata matches (the version test reads it).

Before its closing commit, the closer brings the docs up to date with
the phase: README.md (its install line naming the new release),
docs/player.md (the reference for every key, control, screen and
setting), CREATE.md and the docs the phase touched. When anything the
README screenshots show has changed (the Esc screen, the branch map,
bookmarks, the reading screen), it reruns `npm run screenshots` and
looks at each new image before committing it.

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
