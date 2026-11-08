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
- `KINETIC_SCENARIO_TIMEOUT_MS=<ms>` sets each scenario file's wall-clock
  limit (default 300000, 5 minutes: about 3x `playall`, the slowest). A scenario past it FAILs with
  `finished within <ms> ms`, naming the session and the last check it
  reached; its Chrome is killed and the run goes on, exiting non-zero.

Each `player/scripts/scenarios/*.scenario.mjs` file opens one or more FRESH
browser profiles (a first-ever load each), so no scenario depends on
another. The runner prints PASS / PARTIAL / FAIL per check with evidence
for anything that did not pass, adds a "console stayed clean" check for
every browser a scenario opened, and exits non-zero on any FAIL. Scenarios
read every demo string, id and timing from the manifest through the
harness (`harness.mjs`: `item(id)`, `branch(id)`, `currentItemId`), so a
demo text edit never breaks them. A fresh profile has Play all routes
On (its default); a session that answers decisions itself opens with
`open(name, { closeHelp: true, manualChoices: true })`, which turns it
Off on the Esc screen first (`harness.setPlayAll`). `branches` does this.

| Scenario | Covers |
|---|---|
| `smoke` | one check per area: Space, the chain video playing, a wheel step back, `t` doing nothing, `b` + `m` showing the bookmark's card on the map + Esc opening the settings, a decision opening |
| `reading` | first-load Esc screen (keys without `c`, settings under them), Space closing it (and entering fullscreen), manual default, `a` on/off (on counts time already shown) with its "Auto-forward on" / "Auto-forward off" pills (none at load; Space stopping auto shows the off pill), speech / thought / narration / bare picture, `h`, one press = one item, one notch = one step |
| `media` | animation fps and loops, video under a text chain (same element, poster first), ranges of one file with a loop restart point, contain fit at two viewports and a mismatched asset, minimum play time in auto, skip through it, loop count, WebM `holdSeconds` |
| `navigation` | wheel steps and clamps, poster on rewind, Tab inert with nothing seen ahead, skip stopping ON the last seen item, Space stopping skip, `e` to the furthest point read / no-op there, the wheel walking a route path along the last picks, each choice screen a step with the route taken highlighted, never an unplayed route |
| `screens` | first-load help left up by a click (Space closes it), Esc screen mid-flow (paused, settings beside the keys from 700 px wide and under them below, keys filling across before down in a narrow window, the whole screen fitting 1280x720, 700x900 and 800x600 with no scroll either way, `c` inert, a click leaving it up, Space closing it even with a settings button focused, without pressing that button; headed by the manifest `title`, which is also the page title; no heading and page title `Kinetic` in the untitled empty folder), the map from the Esc screen (a click on the hover-lit M entry, the only clickable one, swaps the screen for the branch map with no frame of neither, story paused under it; Esc then returns to the game with auto-forward resuming, not to the Esc screen; a bookmark's card picked on it lands; `KINETIC_ESC_M_SHOTS=<dir>` saves the hovered entry), bookmarks on the map (`b`, `m` showing a card per bookmark in story order with its picture and time, the newest marked; the timeline suspended under the map; a card click continuing there with the wheel walking the story around it; × deleting (a ghost, storage dropping the row; gone on reopen and after a reload); with eight bookmarks eight cards in view at 1280x720, × deleting and a click continuing; `KINETIC_MAPCARDS_SHOTS=<dir>` saves a screenshot; 60 seeded old-format rows showing within 300 ms of `m`), reload resume (a walked-back screen too), `b` then instant reload, settings on the Esc screen (`c` opening nothing, Esc opening them, a backdrop click leaving them open, Esc closing them; the "When Tab skips" options and the Progress group (export, import, reset) grouped, labels and headings on one edge, the switches in one column, Export, Import and Reset on one line; live and persisted; Play all routes On by default, a saved Off surviving a reload; the Progress note and the Play all routes note), the empty-manifest folder, Reset progress (the box blocking the screen's keys: Space inert, Esc cancelling the box alone; restoring 1.00x and Play all routes On) |
| `branches` | decision firing, the ending route and its re-offer, the nested decision, the Return row rule, continuing-route join, resume inside branch content and the last picks surviving a reload, `e` to the furthest point read, walked choice screens (route highlighted) and real picks from them, the wheel leaving choices and passing through them both ways, scroll-back following the last pick (Route 2 then Route 1: Route 1's path only), an ending route stopping the walk, the ending hint, walking back before a decision after reading one route (the choice fires again, Route 2 still marked seen, Route 1 pickable) |
| `playall` | Play all routes (on by default; the walks find it On on the Esc screen) with skip-all on one Tab (each choice shown and picked at once, no countdown, continuing route last), the on-screen countdown sized to every word on the screen plus comprehension time, with the next pick marked from its start, then the highlighted pick changing no word on #choice (status, seconds, hint stay as the countdown left them, first offer and re-offer), shortest route first, the re-offer's "Back in time: “<route>” is done." line, Space taking the pick, a digit picking another route, the continuing route's join with no choice, route pills (~1.6 s, no back pill after an auto-pick), no ending hint at play-all route endings, the Esc screen over a counting-down choice (countdown frozen, digits inert, restarted on close), `c` inert on it, walking back before the first decision after every route played (with Space and with auto-forward: the choice and its countdown show again and every route plays again in the same order, seen marks kept) |
| `branchmap` | the branch map (docs/plan.md Phase 31) on the demo after playing Route 2 through: `m` opens it with both decisions and four routes, marks (outer reached, nested faded and inert, Route 2 played and outlined as the last pick, Route 1 unseen), the "you are here" marker on Route 2's line; (Phase 40) decisions 52 x 28 and route pills 32 x 24 world units, their 13 px figures' digits centred within 0.25 px; the wheel zooming around the pointer, a drag panning by the distance moved (and clicking nothing), F fitting every node in view, clicks on the unreached nested decision and its route doing nothing, Esc returning to the game (not the Esc screen); a click on Route 1 entering it at its first screen and closing the map, reading on reaching the nested decision; a click on the outer decision opening its choice screen with the last pick highlighted; the wheel over the open map leaving the story where it was; `m` on the Esc screen replacing it, Esc then back to the game; (Phase 33, Phase 35) the header being the title and exactly the Spoilers, Newest bookmark, Centre, 100% and Fit buttons hinting "shortcut: S/N/C/1/F" on one line at 800x600 and 1920x1080; Fit filling the view or stopping at the 3x zoom-in limit centred (the compact demo in a big window); the first open being a Fit; a zoomed and panned view reopening with the same transform after a close and after a reload, at another window size keeping its world centre and scale; after F a reopen at another size being a fresh Fit; after Reset progress a Fit with the marker's ring within 2 px of the start dot (also zoomed to 3x); (Phase 40, map lines) the lead-in's read stretch painting 5 screen pixels wide at Fit (about 2.4x on the demo), 100% and 3x, equal within half a step of `--line-px` (0.22 px) plus 0.5 px (measured from screenshot pixels with the rest of the map hidden), and `--line-px` set on the world group, whose only text is the decision figures (the counts and pill numbers outside it); screenshots `.tmp/branchmap-shots/simp-*.png`, `lines-*.png` |
| `continueroute` | routes with `result: "continue"` (docs/plan.md Phase 38) on a folder of its own built from the demo's images (one decision: Negotiate and Pay continue, Contract is the continuing route, all into one shared scene): with Play all routes off, Pay's last item stepping straight to the shared scene with no choice screen between (a page-side log), one wheel notch back from the shared scene showing Pay's last item and one forward the shared scene; the branch map drawing the three routes as join lines into the decision's join, no return line and no end mark but the story's; with Play all routes on, Negotiate's end and Pay's end each re-offering the choice ("Back in time: “<route>” is done.") and Contract, played last, joining the shared scene; content added since (docs/plan.md Phase 39), on a second copy of the folder: Contract read through to the shared scene, the manifest (and manifest.js) rewritten with Contract extended by two items, the page reloaded, then one wheel notch back from the shared scene showing Contract's old last item (passing over the new unseen end), a notch forward staying there and Space reading on into the new item |
| `bookmarkmap` | bookmarks on the branch map (docs/plan.md Phase 35) on the demo with bookmarks taken by `b`: `t` doing nothing over the story, the Esc screen (no T row, 11 rows, M the only button, its M row reading "branch map and bookmarks") and the map; cards in story order along the line with their pictures, only the newest marked, the newest card centred on the "you are here" point for its screen and the others on the same line; 1 (100%) showing them 280 px wide with their timestamps, none overlapping, each its 280 x 158 thumbnail alone (no caption strip, Phase 40; the newest outlined and labelled "(newest)"), the count line under them clear of the cards; Delete, Backspace and Enter doing nothing to a hovered card; a drag that starts on a card panning by the distance moved and opening nothing; through 8 drags each card moving with the drag, keeping its offset from the SVG, and the painted line running through the gap between two cards at their centre height (a screenshot read back pixel by pixel); a card click opening its bookmark; hovering a card at 100% and at Fit (a card, the newest, a ghost) showing the map tooltip whose whole text is the card's timestamp (Phase 36); at 100% a hovered card's × (24 px, its instant "Delete this bookmark" hint, no card tooltip over it), deleting into a ghost with the toast, no card tooltip over the ghost's Undo, the ghost's Undo, Z; at Fit (cards small) the × still shown at 14-24 px in the card's corner, no card tooltip over it, a ghost a dashed outline of at least a screen pixel, a click on the ghost or the toast's Undo restoring it; a delete standing at close being final; a small card's click at Fit opening it; screenshots `.tmp/bookmarkmap-shots/` |
| `storyid` | progress keyed by the manifest's `storyId`: a manifest without one stores under the folder URL, adding the id carries progress and bookmarks over to `story:<id>` (folder-URL record gone), and a moved and renamed folder resumes where it was with its bookmark |
| `progress` | export / import progress: one browser reads, bookmarks, sets 2.00x and exports (a real download of `<storyId>-progress.json`, checked field by field); a fresh profile on the same folder refuses another story's file in the Esc screen's settings (no box, nothing stored), then imports the real file through the confirm box and reloads onto the same item with the bookmark, 2.00x and help closed; one more item survives a reload (saving automatic again) |

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
- FIXED (was OBSERVED since the branch fixture made range-b mid-story):
  its last pass report advances the machine INSIDE the same `ended`
  event, and the next item's `applyVideoMode` reset the counter under
  the old handler, which then seeked the element back to the old
  `loopStartSeconds` and replayed [1.5, 2.0] once. The renderer now
  reports each pass through `reportEnd`, and every boundary path
  (`passBoundary`, `onVideoEnded`, the autoplay-rejection fallback)
  stops when the report has replaced the plan, so a stale end never
  seeks, replays or reports for the next item (`visual.test.ts`, "a
  stale end event never touches the next item's playback"). The step's
  arithmetic counts only what happened while the item was on screen.

