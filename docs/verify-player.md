# Verify the Player

End-to-end checks of the built player against the real demo
(`fixtures/demo`) in headless Chrome. Unit tests (`npm test`) pin the
machine and renderer rules; these scenarios prove them on screen.

## Run it

From `player/`:

- `npm run verify` builds the player, assembles the demo folders under
  `.tmp/scenarios/` and runs every scenario.
- `npm run verify -- branches` (any substring) runs only the matching
  scenario files; build first with `npm run build` when calling
  `node scripts/scenarios/run.mjs` directly.
- `npm run verify -- --smoke` runs only `smoke.scenario.mjs`: one quick
  check per area in about 5 s, for per-change runs.
- `KINETIC_SCENARIO_ROOT=../.tmp/scenarios-<x>` gives a run its own folders
  and profiles, so runs can overlap.

Each `player/scripts/scenarios/*.scenario.mjs` file opens one or more FRESH
browser profiles (a first-ever load each), so no scenario depends on
another. The runner prints PASS / PARTIAL / FAIL per check with evidence
for anything that did not pass, adds a "console stayed clean" check for
every browser a scenario opened, and exits non-zero on any FAIL. Scenarios
read every demo string, id and timing from the manifest through the
harness (`harness.mjs`: `item(id)`, `branch(id)`, `currentItemId`), so a
demo text edit never breaks them.

| Scenario | Covers |
|---|---|
| `smoke` | one check per area: Space, the chain video playing, a wheel step back, `b` + `t` + `c`, a decision opening |
| `reading` | first-load key help, Space closing it (and entering fullscreen), manual default, `a` on/off, speech / thought / narration / bare picture, `h`, one press = one item, one notch = one step |
| `media` | animation fps and loops, video under a text chain (same element, poster first), ranges of one file with a loop restart point, contain fit at two viewports and a mismatched asset, minimum play time in auto, skip through it, loop count, WebM `holdSeconds` |
| `navigation` | wheel steps and clamps, poster on rewind, Tab inert with nothing seen ahead, skip stopping ON the last seen item, Space stopping skip, `e` to the end of the history / no-op there, the wheel replaying a route path with its choice screens and never an unplayed route |
| `screens` | Esc help mid-flow (paused, `t` blocked, `c` replacing it), bookmarks (`b`, `t` list, click to continue and append to the history, closing), reload resume (a rolled-back screen too), `b` then instant reload, config (the "When Tab skips" options grouped and indented, controls in one column; live and persisted), the empty-manifest folder, Reset progress |
| `branches` | decision firing, the ending route and its re-offer, the nested decision, the Return row rule, continuing-route join, resume inside branch content and the history surviving a reload, `e` to the end of the history, replayed choice screens and real picks from them (a fork), the wheel leaving choices, scroll-back showing every screen in reading order (Route 2 then Route 1), the ending hint |
| `playall` | Play all routes with skip-all on one Tab (each choice shown and picked at once, no countdown, continuing route last), the on-screen countdown sized to the screen's reading time then the highlighted pick, shortest route first, the re-offer's "Back in time" line, Space taking the pick, a digit picking another route, the continuing route's join with no choice, route pills (~1.6 s, no back pill after an auto-pick), no ending hint at play-all route endings, `c` over a counting-down choice (countdown frozen, digits inert, restarted on close) and over the help |

## Old driver steps

The one-sequence driver (`scripts/verify.mjs`, 47 steps, retired in Phase
18) maps onto the scenarios as follows. Steps whose rule changed in Phase
18 are checked against the new rule.

| Old step | Scenario |
|---|---|
| 1-8, 21, 45 | `reading` |
| 9-13, 29-30, 32, 43-44 | `media` |
| 14-19 | `navigation` |
| 20, 22-28, 31, 42, 47 | `screens` |
| 33, 41 (console clean) | every scenario (runner check) |
| 34-39, 46 | `branches` (46's tab-skip pause also in `branches`) |
| 40 | `playall` |

## Measured boundary guarantee

The player makes NO frame-exact claim about range boundaries; it
measures what the browser actually presents and states the guarantee it
keeps: playback stays inside the range, and boundaries land within the
tolerances below. Walked 2026-10-31 (on the pre-Phase-18 demo; the range clip is unchanged), headless Chrome 156.0.8078.76:

- `requestVideoFrameCallback` availability: **available** (Chrome/Edge/
  Safari have it; Firefox pre-133 does not — the renderer checks at
  runtime and falls back to `timeupdate`, which fires only every
  ~4-250 ms and so lands boundaries up to that coarse interval late;
  the fallback notes itself once on the console when used).
- OBSERVED max start offset (first presented frame after entering a
  range, both ranges): **+0.000 s** — the entry seeks landed exactly on
  `startSeconds` this run; treat this as measured on this browser/file
  pair, not a universal bound. Keyframe-gated seeks could land on an
  earlier frame elsewhere; the format doc's guarantee is in-range
  playback, never frame-exact starts.
- OBSERVED max end overshoot (pass-complete past `endSeconds`, rVFC
  path): **+0.000 s** at 25 fps, with frame cadence 0.04 s bounding it by
  construction — a pass completes on the first PRESENTED frame at or
  after the bound, so the overshoot is bounded by the presentation
  cadence, not by a promise. The `timeupdate` fallback would replace
  that bound with its ~4-250 ms cadence.
- OBSERVED loop-back landing past `loopStartSeconds` (range-b's seek
  back to 1.5 after pass 1): **+0.020 s** (`mediaTime=1.520`) — a pass
  resumes on the first PRESENTED frame at or after the restart point,
  and 1.5 s is not itself a 25 fps frame time (frames sit at 1.48 and
  1.52), so this is the cadence bound working as designed. The landing
  was at 1.5, not 1.0: the pre-roll played once, as Phase 9d requires.
- The media scenario asserts generous bounds (≤ 0.15 s start offsets and
  loop-back landing offsets, ≤ 0.25 s rVFC overshoot, range containment
  [-0.05, end+0.05]) so a slower machine still passes while the
  OBSERVED numbers above record what this one showed.
- OBSERVED since the branch fixture made range-b mid-story: its last
  pass report advances the machine INSIDE the same `ended` event, and
  the renderer's counter reset under its own handler lets the hidden
  element replay [1.5, 2.0] once before resting (reported, engine untouched). The step's arithmetic counts only what happened
  while the item was on screen.

