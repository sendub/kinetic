# Agent Notes

Working rules for agents in this repo. Read docs/plan.md for the phase you
are implementing and docs/stack.md for settled decisions.

## Commands

- Player: from `player/`: `npm test`, `npm run check`, `npm run build`,
  `npm run dev`.
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
  self-test; `--pin` records null checksums and goldens, which the user
  runs, not agents). Run `.venv/bin/kinetic-extract <renpy_project>
  <out>`; it refuses to start until that setup has passed. Tests
  `.venv/bin/pytest converter/ tools/ -q -n auto` (pytest-xdist, one
  worker per core, about 45 s; a single file runs fine without `-n`).
- Media only, no story parse: `.venv/bin/kinetic-media ship <game_root>
  <out> --list requests.json` (format: docs/extracting.md). Both
  `ship` and `rebuild` take `--jobs N` (default: one per core) and
  `--video-jobs N` (default: a quarter of that); `--jobs 1` is the
  serial path, same output. Progress goes to stderr every 10 s.
- Verify or reproduce a folder's media from its ledger and the original
  files: `.venv/bin/kinetic-media rebuild <game_root> <folder>
  [--decoder MODULE:FUNC ...] [--out DIR]` (exit 0 only when every hash
  matches).
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
- ffmpeg and macOS `sips` are on PATH (fixture builders use them); there
  is no Rust toolchain.

## Sandbox gotchas

- `npm install` fails writing `~/.npm`; add `--cache ../.tmp/npm-cache`
  (from `player/`) or `--cache .tmp/npm-cache` (from root).
- No sudo, no system package installs, writes stay inside the repo
  (`.tmp/` and `.venv/` are gitignored and available).
- Headless Chrome for `file://` checks:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  --headless=new --no-sandbox --disable-gpu --disable-crash-reporter
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
- Python change: `pytest` on the touched test file only.
- The full suite (`npm run verify` with no filter, full pytest,
  `package-proof`) runs ONCE when the current phase is believed
  complete, before its closing commit.

## Workflow

Every user request for a fix or feature becomes a checklist item in
docs/progress.md, implemented by a fresh-context subagent. The
orchestrator writes the item, briefs the subagent, verifies the result
itself (the test-speed rules above), ticks the item with an evidence
note, then commits and pushes before starting the next item. The
orchestrator does not implement items inline.

## Git

Subagents do not run git add/commit/push and never edit docs/progress.md;
the orchestrator verifies each checklist item, commits and pushes.
