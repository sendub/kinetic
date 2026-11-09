# Verify the Player

End-to-end checks of the built player against the real demo
(`fixtures/demo`) in headless Chrome, or with `--webkit` in the system
WebKit the macOS game app uses ([WebKit](#webkit)). Unit tests
(`npm test`) pin the machine and renderer rules; these scenarios prove
them on screen.

## Run it

From `player/`:

- `npm run verify` builds the player, assembles the demo folders under
  `.tmp/scenarios/` and runs every scenario.
- `npm run verify -- branches` (any substring) runs only the matching
  scenario files; build first with `npm run build` when calling
  `node scripts/scenarios/run.mjs` directly.
- `npm run verify -- --smoke` runs only `smoke.scenario.mjs`: one quick
  check per area in about 5 s, for per-change runs.
- `npm run verify -- --webkit [filters]` (or `node scripts/scenarios/run.mjs
  --webkit ...`) runs the same files on WebKit instead of Chrome; the
  runner's first and last lines name the engine.
- `npm run verify -- --jobs=<n>` (or `KINETIC_SCENARIO_JOBS=<n>`) sets how
  many files or parts run side by side, each in its own process (default
  half the cores, at most 4, which keeps the timing checks steady on a
  shared machine; `--jobs=8` is faster on a quiet one, `--jobs=1` runs
  one at a time). They start
  longest first, by the times the last run left in
  `.tmp/scenario-times.json`. A file's block prints once all its parts
  are done, its checks in the order a one-at-a-time run gives.
- `KINETIC_SCENARIO_ROOT=../.tmp/scenarios-<x>` gives a run its own folders
  and profiles, so runs can overlap.
- `KINETIC_SCENARIO_TIMEOUT_MS=<ms>` sets the wall-clock limit of each
  file, or of each part of a file that has them (default 300000, 5
  minutes; the slowest part takes under 50 s). One past it FAILs with
  `finished within <ms> ms`, naming the session and the last check it
  reached; its Chrome is killed and the run goes on, exiting non-zero.

Each `player/scripts/scenarios/*.scenario.mjs` file opens one or more FRESH
browser profiles (a first-ever load each), so no scenario depends on
another. A file exports a default function, or `parts`: functions that
share nothing (each opens its own browsers and folders), which the runner
can run at the same time. The runner prints PASS / PARTIAL / FAIL per
check with evidence for anything that did not pass, adds a "console
stayed clean" check for every browser a scenario opened, and exits
non-zero on any FAIL. Scenarios
read every demo string, id and timing from the manifest through the
harness (`harness.mjs`: `item(id)`, `branch(id)`, `currentItemId`), so a
demo text edit never breaks them. What the creators' testing library
also uses (launching either engine, the key and click helpers, the
generic page readers and the item lookup) lives in
`player/scripts/testing/core.mjs`, which the harness re-exports. A fresh profile has Play all routes
On (its default); a session that answers decisions itself opens with
`open(name, { closeHelp: true, manualChoices: true })`, which turns it
Off on the Esc screen first (`harness.setPlayAll`). `branches` does this.
`open(name, { host: { kind, display } })` opens the page as a game app
shows it, with a recording host (`harness.installRecordingHost`, returned
as `host`: `messages()`, `waitForMessages(n)`, `setDisplay(mode)`). On
WebKit that is the macOS app's own bridge; in Chrome it is a small
stand-in of the same shape as that bridge and the Windows exe's creation
script (`apps/windows/host.go`, whose behaviour its `go test` checks in
Node). Headless Chrome runs with `--screen-info`
reporting a 1920x1200 screen (`harness.CHROME_SCREEN`), larger than its
window as a reader's is; otherwise the player would read every window as
filling the screen and never ask for fullscreen.

| Scenario | Covers |
|---|---|
| `smoke` | one check per area: Space, the chain video playing, a wheel step back, `t` doing nothing, `b` + `m` showing the bookmark's card on the map + Esc opening the settings, a decision opening |
| `reading` | first-load Esc screen (keys without `c`, settings under them), Space closing it (and entering fullscreen), manual default, `a` on/off (on counts time already shown) with its "Auto-forward on" / "Auto-forward off" pills (none at load; Space stopping auto shows the off pill), speech / thought / narration / bare picture, `h`, one press = one item, one notch = one step |
| `media` | animation fps and loops, video under a text chain (same element, poster first), ranges of one file with a loop restart point, contain fit at two viewports and a mismatched asset, minimum play time in auto, skip through it, loop count, WebM `holdSeconds` |
| `navigation` | wheel steps and clamps, poster on rewind, Tab inert with nothing seen ahead (and no pill), skip stopping ON the last seen item, Space stopping skip, the "Skip on" / "Skip off" pills for both stops, `e` to the furthest point read / no-op there, the wheel walking a route path along the last picks, each choice screen a step with the route taken highlighted, never an unplayed route |
| `screens` | first-load help left up by a click (Space closes it), a short Escape in fullscreen opening the Esc screen with fullscreen kept (Keyboard Lock), Esc screen mid-flow (paused, settings beside the keys from 700 px wide and under them below, keys filling across before down in a narrow window, the whole screen fitting 1280x720, 700x900 and 800x600 with no scroll either way, `c` inert, a click leaving it up, Space closing it even with a settings button focused, without pressing that button; headed by the manifest `title`, which is also the page title; no heading and page title `Kinetic` in the untitled empty folder), the map from the Esc screen (a click on the hover-lit M entry, the only clickable one, swaps the screen for the branch map with no frame of neither, story paused under it; Esc then returns to the game with auto-forward resuming, not to the Esc screen; a bookmark's card picked on it lands; `KINETIC_ESC_M_SHOTS=<dir>` saves the hovered entry), bookmarks on the map (`b`, `m` opening at Full size and showing a card per bookmark in story order with its picture and time, the newest marked; the timeline suspended under the map; a card click continuing there with the wheel walking the story around it; × deleting (a ghost, storage dropping the row; gone on reopen and after a reload); with eight bookmarks eight cards in view at Full size at 1280x720, × deleting and a click continuing; `KINETIC_MAPCARDS_SHOTS=<dir>` saves a screenshot; 60 seeded old-format rows showing within 300 ms of `m`, N scrolling to the newest, whose click lands on its item), reload resume (a walked-back screen too), `b` then instant reload, settings on the Esc screen (`c` opening nothing, Esc opening them, a backdrop click leaving them open, Esc closing them; the "When Tab skips" options, the Progress group (export, import, reset) and the Game window group (Fullscreen \| Window, Exit) grouped, labels and headings on one edge, the switches in one column, Export, Import and Reset on one line; live and persisted; the speed readout reading `1.00x (~60 ms/char)` and `2.00x (~30 ms/char)` after four + clicks, written out in the check rather than taken from the player's code; Play all routes On by default, a saved Off surviving a reload; the heading "Progress · saved automatically", Play all routes one line as tall as a skip switch's row, and no note or message lines), the Esc screen's layout (docs/plan.md Phase 43 item 12: the Keys card and the Settings section the same width within 1 px at 1920x1080, 1280x720, 800x600 and 700x900; with stretching off (each column at the start of its grid area) their natural bottoms within 20 px, and with it on ending level within 2 px, at 1920x1080, 1280x720 and 800x600; a settings section 120 px taller, as a wider system font makes it, stretching the Keys card to its end with every key row growing by the same height; a Keys card 120 px taller stretching the settings to its end, the four gaps between settings groups growing by the same height, nothing inside a group moving and the speed cell's top staying level with the card's; stacked at 600x900 neither column stretching; the - slider + row spanning the speed cell, - and + on its padding edges, the readout ending on +'s edge and never over the label, the cell's bottom rounded, at 1920x1080, 1280x720, 800x600 and 700x900; the Game window row with Fullscreen's left edge and Exit's right edge on the cards' outer edges at 1920x1080, 1280x720, 800x600 and 700x900), the "?" tips after Auto-forward speed, Play all routes and the Progress heading (keyboard focus and hover each showing the moved note within a frame, inside the settings column, at 1280x720 and 700x900, on a button named "About …" with no title; a click pinning a tip open and a second click shutting it under the pointer, one tip at a time, the screen staying open, no fullscreen asked and no setting changed; Space and Escape with a "?" focused still closing the screen; each glyph's ink box centred on its ring within 1 px in a screenshot at 1920x1080 and 800x600; in the same screenshots, each ring's painted centre within 1 px of half its text's cap height above the baseline, both read from the ink of the label's or heading's first capital, and the ring 1.3 to 1.7 cap heights across), the empty-manifest folder, Reset progress (the box blocking the screen's keys: Space inert, Esc cancelling the box alone; restoring 1.00x and Play all routes On), a content update (docs/plan.md Phase 18: two prequel items and a deleted one; the save naming items by id, the seen ids in their own records, Phase 46), and two items inserted inside read content after a full read (Phase 46: the state record holding the place with an empty seen list and every seen id in the seen records; the resume notice; the end card one screen on counting unseen content and offering `u`; `u` landing on the first inserted item; Tab from a bookmark before them stopping on the first, short of the one still unseen) |
| `branches` | decision firing, the ending route and its re-offer, the nested decision, the Return row rule, continuing-route join, resume inside branch content and the last picks surviving a reload, `e` to the furthest point read, walked choice screens (route highlighted) and real picks from them, the wheel leaving choices and passing through them both ways, scroll-back following the last pick (Route 2 then Route 1: Route 1's path only), an ending route stopping the walk, the ending hint, walking back before a decision after reading one route (the choice fires again, Route 2 still marked seen, Route 1 pickable), Tab and `a` on a choice screen (docs/plan.md Phase 43: each pill shown over the choice, nothing moving; skip turning off at the pick of an unseen route, and running a read route to its last item; auto-forward running the route after the pick) |
| `playall` | Play all routes (on by default; the walks find it On on the Esc screen) with skip-all on one Tab (each choice shown and picked at once, no countdown, continuing route last), the on-screen countdown sized to every word on the screen plus comprehension time, with the next pick marked from its start, then the highlighted pick changing no word on #choice (status, seconds, hint stay as the countdown left them, first offer and re-offer), shortest route first, the re-offer's "Back in time: “<route>” is done." line, Space taking the pick, a digit picking another route, the continuing route's join with no choice, route pills (~1.6 s, no back pill after an auto-pick), no ending hint at play-all route endings, the Esc screen over a counting-down choice (countdown frozen, digits inert, restarted on close), `c` inert on it, walking back before the first decision after every route played (with Space and with auto-forward: the choice and its countdown show again and every route plays again in the same order, seen marks kept), Tab during a countdown ("Skip on" over the choice, the countdown unchanged, skip running the auto-picked read route to its last item, then "Skip off") |
| `branchmap` | the branch map (docs/plan.md Phase 31) on the demo after playing Route 2 through: `m` opens it with both decisions and four routes, marks (outer reached, nested faded and inert, Route 2 played and outlined as the last pick, Route 1 unseen), the "you are here" marker on Route 2's line; (Phase 40) decisions 52 x 28 and route pills 32 x 24 world units, their 13 px figures' digits centred within 0.25 px; (Phase 41) the first open at Full size (its half pressed), scale exactly 1, the demo shorter than the view so the wheel, a drag, the scrolling keys and + move nothing (and the drag clicks nothing); a drag or double click selecting no text; F switching to Fit with every node in view, clicks on the unreached nested decision and its route doing nothing, Esc returning to the game (not the Esc screen); the map reopening at Fit as it was left, a click on Route 1 there entering it at its first screen and closing the map, reading on reaching the nested decision; a click on the outer decision opening its choice screen with the last pick highlighted; the wheel over the open map leaving the story where it was; `m` on the Esc screen replacing it, Esc then back to the game; Fit filling the view or stopping at 3x centred at 1280x720, after resizes to 1920x1080, 2560x1440 and back (back to the same picture), and when opened at 2560x1440; the marker on the story's and Route 2's end marks when fully seen; Spoilers (off by default, no hidden text in the DOM, S and the button, the tree unmoved, surviving a reload); the marker's ring and label inside the view at Full size (after C) and at Fit, at the story's start and end, at 800x600 and 1920x1080; the header being the title and exactly the Spoilers, Newest bookmark and Centre buttons and the touching halves of "Full size \| Fit" (Full size pressed) hinting "shortcut: S/N/C/F/F" on one line at 800x600 and 1920x1080, each hint showing within a frame of a hover or keyboard focus; (Phase 41, two views, the demo with five bookmarks at 800x600) Full size with every card and line across the view and the scroll bar shown, the wheel scrolling by its delta while a sideways wheel and a ctrl+wheel (pinch) move nothing, Up/Down 80 px, Page Up/Page Down 0.875 of the view, Home/End the ends, Left/Right, +/-, 0 and 1 nothing, the scroll bar's thumb dragged 40 px scrolling in proportion and a press on its track paging, a drag of the map scrolling up or down only and opening nothing, then a click on a card (moving under 5 px) opening it; Fit not moving for the wheel, a drag, the scrolling keys or +, with no scroll bar; the header's halves and F switching views (the pressed half doing nothing); C and N switching from Fit to Full size centred on the marker and on the newest card; the remembered view: the first open Full size centred on the marker (C then changing nothing), a scrolled view reopening with the same transform after a close and after a reload, C then a scroll then C again making the next open (and the one after a reload) centre on the marker where the reader has got to, not the scrolled place, a resize at Full size keeping N's card in the middle, a resize at Fit fitting again and a Fit reopening as a fresh Fit for the window, a bookmark added since making a Full size open centre on the marker rather than the top it was scrolled to, and after Reset progress a Full size open with the marker's ring within 2 px of the start dot (at Fit too); (Phase 40, map lines) the lead-in's read stretch painting 5 screen pixels wide at Fit in 1280x720 (about 3x), Full size and Fit at 3x in 1920x1080, equal within half a step of `--line-px` (0.22 px) plus 0.5 px (measured from screenshot pixels with the rest of the map hidden), and `--line-px` set on the world group, whose only text is the decision figures (the counts and pill numbers outside it); (Phase 41, one look at every scale) on a 220-node tree built for the check (node groups from 0.6x), its first decision reached and route 1 the last pick, the window sized so Fit lands just above 0.6x (node groups) and just below (merged), the decision and the pill captured at 4x device pixels with the lines and marker hidden and compared on a 10 x 8 grid of mean colours over each node's ink box, the same within a mean of 0.03 and a worst cell of 0.2 (shares of 255), with a figure standing out of the fill on both; screenshots `.tmp/branchmap-shots/simp-*.png`, `views-*.png`, `lines-*.png`, `look-*.png` |
| `continueroute` | routes with `result: "continue"` (docs/plan.md Phase 38) on a folder of its own built from the demo's images (one decision: Negotiate and Pay continue, Contract is the continuing route, all into one shared scene): with Play all routes off, Pay's last item stepping straight to the shared scene with no choice screen between (a page-side log), one wheel notch back from the shared scene showing Pay's last item and one forward the shared scene; the branch map drawing the three routes as join lines into the decision's join, no return line and no end mark but the story's; with Play all routes on, Negotiate's end and Pay's end each re-offering the choice ("Back in time: “<route>” is done.") and Contract, played last, joining the shared scene; content added since (docs/plan.md Phase 39), on a second copy of the folder: Contract read through to the shared scene, the manifest (and manifest.js) rewritten with Contract extended by two items, the page reloaded, then one wheel notch back from the shared scene showing Contract's old last item (passing over the new unseen end), a notch forward staying there and Space reading on into the new item |
| `bookmarkmap` | bookmarks on the branch map (docs/plan.md Phase 35) on the demo with bookmarks taken by `b`: `t` doing nothing over the story, the Esc screen (no T row, 11 rows, M the only button, its M row reading "branch map and bookmarks") and the map; cards in story order along the line with their pictures, only the newest marked, the newest card centred on the "you are here" point for its screen and the others on the same line; the map opening at Full size (Phase 41), which shows them 280 px wide with their timestamps, none overlapping, each its 280 x 158 thumbnail alone (no caption strip, Phase 40; the newest outlined and labelled "(newest)"), the count line under them clear of the cards; Delete, Backspace and Enter doing nothing to a hovered card; in a 1280x400 window, where Full size scrolls, a drag that starts on a card scrolling up or down by the distance moved (never sideways) and opening nothing, and through 8 drags the view scrolling by each drag within the map's ends, each card moving with it, keeping its offset from the SVG, and the painted line running through the gap between two cards at their centre height (a screenshot read back pixel by pixel); a card click opening its bookmark; hovering a card at Full size and at Fit (a card, the newest, a ghost) showing the map tooltip whose whole text is the card's timestamp (Phase 36); at Full size a hovered card's × (24 px, its instant "Delete this bookmark" hint, no card tooltip over it), deleting into a ghost with the toast, no card tooltip over the ghost's Undo, the ghost's Undo, Z; at Fit (cards small: taken at 800x500, under 0.7x) the × still shown at 14-24 px in the card's corner, no card tooltip over it, a ghost a dashed outline of at least a screen pixel, a click on the ghost or the toast's Undo restoring it; a delete standing at close being final; the map reopening at Fit as it was left and a small card's click there opening it; screenshots `.tmp/bookmarkmap-shots/` |
| `storyid` | progress keyed by the manifest's `storyId`: a manifest without one stores under the folder URL (its seen records too, docs/plan.md Phase 46), adding the id carries progress, seen records and bookmarks over to `story:<id>` (folder-URL record and seen records gone), and a moved and renamed folder resumes where it was with its bookmark |
| `window` | the Esc screen's window controls (docs/plan.md Phase 43): under a recording host, for both `mac-app` and `windows-app`, keys and clicks never asking for element fullscreen, the switch showing the host's mode, the Window half sending `{ type: "display", mode: "window" }` with Fullscreen still pressed until the host switches, a host-side change moving the pressed half (with the screen open, and while closed), the pressed half sending nothing, a reload starting in the host's mode then in force, Exit sending `{ type: "quit" }`; in a tab, Escape never asking, a key asking while windowed and not while fullscreen, asking again after leaving fullscreen, Window leaving fullscreen and stopping the asking across a reload, Fullscreen asking at once, a click on a settings control asking nothing, a window the size of the screen asking nothing, a host that appears after load taking over; Exit saying to close the tab in the `#flash` pill where the page may not close it (no refused `window.close()`, nothing on the Esc screen moving), and closing a tab opened straight on the game (one history entry); held keys under the `mac-app` host (`harness.holdKey`: a keydown, five auto-repeats, a keyup): the page taking every keydown of Esc, Space and Tab, repeats included, and acting on the first alone (the Esc screen opening and staying open, Space closing it with the story unmoved), and leaving a held `z` alone; on WebKit, nothing of the held Esc, Space and Tab coming back to the app's window class, and the held `z` coming back, repeats included, and dropped there, never reaching NSWindow's own `keyDown`; ⌘H under the `mac-app` host (`harness.pressShortcut`) left by the page (not prevented) with the text still shown, and a plain `h` still taken and hiding the text; on WebKit, ⌘H offered to the window as a key equivalent, claimed by the web view for the page's turn and then handed back unclaimed (where the app's main menu is offered it), and dropped by the window |
| `creator` | the creators' testing library (`player/scripts/testing/kinetic.mjs`; CREATE.md, "Testing your game") on the run's engine: `openGame` at the first item with the Esc screen closed, `press("Space")` showing the next item's line and speaker, `waitForItem` by id and by a test (and giving up naming the screen), `spaceUntil` to an item and to a choice, `waitForChoice` with the rows, `spaceUntil` refusing to pass a choice with Play all routes off, `pickRoute(2)` entering route 2, `reload` and a reopen with a kept profile resuming there, a fresh open at the start with `closeHelp: false` leaving the first-load Esc screen for Space, a 1280x720 PNG screenshot, two items sharing a line (a copy of the demo) told apart by the player's saved place, a picture missing from another copy named in `errors()` (the library logs failed loads on WebKit, which does not), and `errors()` empty in every open of a whole folder (the library opens its own browsers, so this stands in for the console check) |
| `progress` | export / import progress: one browser reads, bookmarks, sets 2.00x and exports (a real download of `<storyId>-progress.json`, checked field by field; "Progress exported" in the `#flash` pill, solid above the open Esc screen, every settings row where it was); a fresh profile on the same folder refuses another story's file in the pill, still fully shown 600 ms past a mode pill's hold, nothing on the screen moving (no box, nothing stored), then imports the real file through the confirm box and reloads onto the same item with the bookmark, 2.00x and help closed; one more item survives a reload (saving automatic again) |

## WebKit

`--webkit` sets `KINETIC_ENGINE=webkit`, which the runner's child
processes inherit; `harness.openScenario` then starts a WebKit driver
instead of Chrome. Each driver process is a fresh profile, as each Chrome
launch is. The default stays 4 at a time (full suite about 3 minutes);
units start longest first by `.tmp/scenario-times-webkit.json`.

- What runs: `apps/macos/driver/main.swift`, a WKWebView host set up by
  `apps/macos/WebViewSetup.swift`, the one source the macOS game app also
  compiles (file access, media autoplay, file loading, the download
  policy, the page-to-host bridge, and the game window's class,
  `KineticWindow`, which drops every key the page leaves unhandled). A
  key the page leaves unhandled comes back from the web view to that
  window, and the driver reports each as a `windowkey` line
  (`page.windowKeys`): `dropped` where the window drops it, `appkit` if
  it ever reaches NSWindow's own `keyDown` (apps/README.md, "Keys in the
  macOS app"). CDP's `autoRepeat` on a key sends a held key's repeat
  (`isARepeat`). A keydown held with ⌘ (CDP's `modifiers`) goes through
  the driver's NSApp, which offers it to the window as a key equivalent
  first, as AppKit does for the app's key window, and reports the answer
  as a `keyequivalent` line (`page.keyEquivalents`). A session opened with
  `host` gets the app's own bridge (`KineticHostBridge`) with a recording
  host: the driver's `host` request installs it before the first page,
  each message the page sends comes back as a `hostmessage` line, and
  `hostDisplay` changes the mode as the reader's green button would.
  Without it the page runs as in a browser tab; a `window.close()` the
  engine allows comes back as a `windowclose` line (`page.isClosed()`).
  `player/scripts/webkit/puppet.mjs` gives the harness the
  puppeteer and CDP calls it makes; scenario files are unchanged. The
  creators' testing library starts the same driver with
  `--profile=<dir>` when a test keeps a profile: the page's storage is
  then kept in that folder (WebKit's private directory-rooted data
  store), so a later driver given it resumes; the suite never passes it.
- Build: the first run compiles the driver into
  `.tmp/webkit-driver-build/<hash>/` (about 6 s, ad-hoc signed); later
  runs reuse it until a Swift source changes. It needs macOS and Xcode or
  the Command Line Tools (`xcode-select --install`); without them the run
  stops with that message.
- Nothing on screen: the driver is an accessory app (no Dock icon, never active)
  whose one borderless window sits off every screen. It checks that
  before showing the window and whenever the displays change, and quits
  rather than show it; if it ever became the active app it hands focus
  back and fails the session's console check. It writes nothing under
  `~/Library/WebKit`.
- Private WebKit hooks keep the hidden page running as if in front (no
  occlusion, no hidden-page throttling, a 1x scale override) and feed it
  mouse moves and layer-tree waits. The driver's ready line reports each;
  if a macOS update removes one, the run stops naming it rather than
  give wrong results.
- Covered: the app's engine and web view configuration. Not covered:
  Safari itself (same WebKit, its own settings and window); the app's
  persistent storage (each driver keeps its store in memory); Retina
  (pages render at 1x, as in headless Chrome, unless a scenario sets
  `deviceScaleFactor`); fullscreen (WKWebView has element fullscreen
  off, so the five checks that need the page fullscreen are PARTIAL:
  three in `reading` and `screens`, two in `window`. Chrome has none,
  since the player's Keyboard Lock hands a short Esc to the page there,
  which the checks can see); the app's own window switching (the recording
  host stands in for it); a key taking the app's window out of real
  fullscreen (the held-keys checks show instead that no key reaches
  NSWindow's own `keyDown`, where AppKit's keyboard handling runs); the
  app's main menu (the driver has none: the ⌘H check shows instead that
  the web view hands ⌘H back unclaimed, where AppKit offers it to the
  menu).
- A check that branches on `onWebKit` (from the harness) does so only
  where WebKit's own behaviour differs, with the reason beside it:
  `branchmap` reads only `webkitUserSelect` (WebKit has no unprefixed
  `userSelect`), and `screens` focuses the settings button by script
  before Space (WebKit on macOS does not focus a button on click).

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

