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
  `.venv/bin/pip install -e ./converter --cache .tmp/pip-cache`; run
  `.venv/bin/kinetic-extract <renpy_project> <out>`; tests
  `.venv/bin/pytest converter/ -q`.
- ffmpeg and macOS `sips` are on PATH; there is no Rust toolchain.

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
- Browser-visible change: add `npm run build` + ONE targeted scenario
  script against the real demo (~10 s, the `.tmp/repro-*.mjs` pattern).
  Do NOT run the full `verify.mjs` per item.
- Python change: `pytest` on the touched test file only.
- The full suite (44-step `verify.mjs`, full pytest, `package-proof`)
  runs ONCE when the current phase is believed complete, before its
  closing commit. The driver is one sequential stateful script; there
  is no step subset flag.

## Git

Subagents do not run git add/commit/push and never edit docs/progress.md;
the orchestrator verifies each checklist item and commits.
