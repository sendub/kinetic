# Verify the Player

End-to-end checks of the built player against the real demo
(`fixtures/demo`) in headless Chrome, or with `--webkit` in the system
WebKit the macOS game app uses ([WebKit](#webkit)). Unit tests
(`npm test`) pin the machine and renderer rules; these scenarios prove
them on screen. Every run is silent; the sound is checked by ear with the
[Listening checklist](#listening-checklist).

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
`player/scripts/testing/core.mjs`, which the harness re-exports. No run
makes a sound: every Chrome starts with `--disable-audio-output` (media
plays to a fake output stream, so no audio device opens), and the key
helpers send Chrome no native key code except for Escape, so a key the
page leaves unhandled never reaches headless Chrome's app, which would
play the macOS alert sound. A fresh profile has Play all routes
On (its default); a session that answers decisions itself opens with
`open(name, { closeHelp: true, manualChoices: true })`, which turns it
Off on the Esc screen first (`harness.setPlayAll`). `branches` does this.
`open(name, { host: { kind, display } })` opens the page as a game app
shows it, with a recording host (`harness.installRecordingHost`, returned
as `host`: `messages()`, `waitForMessages(n)`, `setDisplay(mode)`). On
WebKit that is the macOS app's own bridge; in Chrome it is a small
stand-in of the same shape as that bridge and the Windows exe's creation
script (`apps/windows/host.go`, whose behaviour its `go test` checks in
Node). `open(name, { hash: "#start=<id>" })` adds the hash to the page's
URL. `open(name, { requireGestureForAudio: true })` starts the WebKit
driver with `--require-gesture-for-audio`, so it refuses sound until a key
or click as Safari does; Chrome always refuses, and the stock driver
plays at once, as the macOS app does. The scenarios on
`fixtures/audio-demo` (`audio`, `videosound` and two `screens` parts)
need it built with `.venv/bin/python fixtures/build_audio_demo.py`, and
FAIL naming that command when it is missing. Besides `errors`, a session
returns `consoleLines`, every console line as `{ type, text }`: Chrome
types `console.warn` `warn` and WebKit `warning`; `errors`
(`collectErrors`) keeps both as `[warning]`, so the console check fails on
a warning on either engine.
Headless Chrome runs with `--screen-info` reporting a 1920x1200 screen
(`harness.CHROME_SCREEN`), larger than its window as a reader's is;
otherwise the player would read every window as filling the screen and
never ask for fullscreen.

| Scenario | Covers |
|---|---|
| `smoke` | one check per area: Space, the chain video playing, a wheel step back, `t` doing nothing, `b` + `m` showing the bookmark's card on the map + Esc opening the settings, a decision opening |
| `reading` | first-load Esc screen (keys without `c`, settings under them), Space closing it (and entering fullscreen), manual default, `a` on/off (on counts time already shown) with its "Auto-forward on" / "Auto-forward off" pills (none at load; Space stopping auto shows the off pill), speech / thought / narration / bare picture, `h`, one press = one item, one notch = one step |
| `media` | animation fps and loops, video under a text chain (same element, poster first), ranges of one file with a loop restart point, contain fit at two viewports and a mismatched asset, minimum play time in auto, skip through it, loop count, WebM `holdSeconds` |
| `videofit` | videos filling the stage (docs/plan.md Phase 46 item 6) on a folder of its own built with ffmpeg (solid green videos of several shapes in MP4 and WebM, blue posters, red pictures): on every path onto a video item, the frames' painted box in a screenshot (the poster's for a still) within 3 px of the box `contain` gives the video's own size in the stage, with no frame, poster or picture pixel outside it: Space onto a video after a picture of another shape and straight after another video, the wheel back onto one (its still) and forward, `e` then a notch back, skip stopping on a video and skip playing one in full, a reload restoring onto one, a resize while one is shown and while it is hidden behind a picture, the page grown to a screen's size under one, and the first video of a load opened at it (`#start=`); and a walk over many videos, pictures, a text line and three ranges of one file never holding more than one `<video>`, giving each new file a fresh one and the ranges one between them, every one let go out of the page with no `src`, `networkState` and `readyState` 0. Headless it cannot fail for the user's report: WebKit draws a playing video in its GPU process, which the off-screen window never renders, and its screenshot paints the frame into the element's box |
| `navigation` | wheel steps and clamps, poster on rewind, Tab inert with nothing seen ahead (and no pill), skip stopping ON the last seen item, Space stopping skip, the "Skip on" / "Skip off" pills for both stops, `e` to the furthest point read / no-op there, the wheel walking a route path along the last picks, each choice screen a step with the route taken highlighted, never an unplayed route |
| `screens` | first-load help left up by a click (Space closes it), a short Escape in fullscreen opening the Esc screen with fullscreen kept (Keyboard Lock), Esc screen mid-flow (paused, settings beside the keys from 700 px wide and under them below, keys filling across before down in a narrow window, the whole screen fitting 1280x720, 700x900 and 800x600 with no scroll either way, `c` inert, a click leaving it up, Space closing it even with a settings button focused, without pressing that button; headed by the manifest `title`, which is also the page title; no heading and page title `Kinetic` in the untitled empty folder), the map from the Esc screen (a click on the hover-lit M entry, the only clickable one, swaps the screen for the branch map with no frame of neither, story paused under it; Esc then returns to the game with auto-forward resuming, not to the Esc screen; a bookmark's card picked on it lands; `KINETIC_ESC_M_SHOTS=<dir>` saves the hovered entry), bookmarks on the map (`b`, `m` opening at Full size and showing a card per bookmark in story order with its picture and time, the newest marked; the timeline suspended under the map; a card click continuing there with the wheel walking the story around it; × deleting (a ghost, storage dropping the row; gone on reopen and after a reload); with eight bookmarks eight cards in view at Full size at 1280x720, × deleting and a click continuing; `KINETIC_MAPCARDS_SHOTS=<dir>` saves a screenshot; 60 seeded old-format rows showing within 300 ms of `m`, N scrolling to the newest, whose click lands on its item), reload resume (a walked-back screen too), `b` then instant reload, settings on the Esc screen (`c` opening nothing, Esc opening them, a backdrop click leaving them open, Esc closing them; the "When Tab skips" options, the Progress group (export, import, reset) and the Game window group (Fullscreen \| Window, Exit) grouped, labels and headings on one edge, the switches in one column, Export, Import and Reset on one line; live and persisted; the speed readout reading `1.00x (~60 ms/char)` and `2.00x (~30 ms/char)` after four + clicks, written out in the check rather than taken from the player's code; Play all routes On by default, a saved Off surviving a reload; the heading "Progress · saved automatically", Play all routes one line as tall as a skip switch's row, and no note or message lines), the Esc screen's layout (docs/plan.md Phase 43 item 12: the Keys card and the Settings section the same width within 1 px at 1920x1080, 1280x720, 800x600 and 700x900; with stretching off (each column at the start of its grid area) their natural bottoms within 20 px, and with it on ending level within 2 px, at 1920x1080, 1280x720 and 800x600; a settings section 120 px taller, as a wider system font makes it, stretching the Keys card to its end with every key row growing by the same height; a Keys card 120 px taller stretching the settings to its end, the four gaps between settings groups growing by the same height, nothing inside a group moving and the speed cell's top staying level with the card's; stacked at 600x900 neither column stretching; the - slider + row spanning the speed cell, - and + on its padding edges, the readout ending on +'s edge and never over the label, the cell's bottom rounded, at 1920x1080, 1280x720, 800x600 and 700x900; the Game window row with Fullscreen's left edge and Exit's right edge on the cards' outer edges at 1920x1080, 1280x720, 800x600 and 700x900), the "?" tips after Auto-forward speed, Play all routes and the Progress heading (keyboard focus and hover each showing the moved note within a frame, inside the settings column, at 1280x720 and 700x900, on a button named "About …" with no title; a click pinning a tip open and a second click shutting it under the pointer, one tip at a time, the screen staying open, no fullscreen asked and no setting changed; Space and Escape with a "?" focused still closing the screen; each glyph's ink box centred on its ring within 1 px in a screenshot at 1920x1080 and 800x600; in the same screenshots, each ring's painted centre within 1 px of half its text's cap height above the baseline, both read from the ink of the label's or heading's first capital, and the ring 1.3 to 1.7 cap heights across), the empty-manifest folder, Reset progress (the box blocking the screen's keys: Space inert, Esc cancelling the box alone; restoring 1.00x and Play all routes On), a content update (docs/plan.md Phase 18: two prequel items and a deleted one; the save naming items by id, the seen ids in their own records, Phase 46), and two items inserted inside read content after a full read (Phase 46: the state record holding the place with an empty seen list and every seen id in the seen records; the resume notice; the end card one screen on counting unseen content and offering `u`; `u` landing on the first inserted item; Tab from a bookmark before them stopping on the first, short of the one still unseen); the same layout checks on fixtures/audio-demo (docs/plan.md Phase 47 item 7: widths within 1 px and natural heights within 20 px at 1920x1080, 1280x720 and 800x600, no scroll at 1280x720, 700x900 and 800x600 with Reset in view); there the Keys card with V, "sound on / off", after H, and a Sound row in Play all routes' group, Volumes... then its switch (On); Volumes... opening a box centred over the Esc screen (Volumes: Music, Effects and Voice each at 100%, focus on the Music slider); the box from the keyboard (the Left arrow stepping Music to 90%, Tab reaching its + and Enter stepping back to 100%, Tab and Shift+Tab cycling through its controls to Done and wrapping, focus never leaving it); Space and m doing nothing under it, Escape closing the box alone with focus back on Volumes..., Done and a click outside each closing it with the Esc screen staying up; and on fixtures/demo, a game without audio, `v` showing no pill and changing nothing over the story or the Esc screen, no audio element, no V row and no Sound row |
| `audio` | sound (docs/plan.md Phase 47 item 5) on fixtures/audio-demo, read through the player's hidden `#audio` (`data-slot`, `data-track`, `data-target`, `data-unlocked`), never by listening, each expected target worked out from the manifest: Space, the wheel, `e`, a bookmark, skip and a reload each landing on the item's target with exactly its music and ambience playing at full level, and skip running on from the bookmark to the last item seen; a loop in both the old and the new ambience set playing on in its element, unrestarted, while the other fades out; a crossfade (both tunes partway, the old falling as the new rises, then the new alone), a `loop: false` track playing once and staying silent, a play starting at `startSeconds` and looping at `loopStartSeconds`, `music: null` fading to silence; a read firing its one-shots (the knock 1.5 s late, the bell cutting the siren on its channel, both together without one), a walk fading out the one-shots playing and a walk or a jump onto one-shot lines firing none, one still waiting dropped when the reader moves on first, skip firing none; `u` landing on the unseen route's first item with its music, and the join playing the music of the route read last (warm, cold entered by `u`, warm, cold); with a gesture required (`requireGestureForAudio` on WebKit, always on Chrome) the first Space unlocking sound, after a reload nothing playing before a key while the target is set and "Press any key for sound" shows in a fixed pill that moves nothing, one Space unlocking, hiding the hint and still advancing, Esc not unlocking and the Space that closes the Esc screen doing so, and a one-shot and a voice line that auto-forward starts seconds after that one key still playing; the stock WebKit driver, like the macOS app, playing after a reload with no key and no hint, and Chrome playing nothing until a key, with the hint; a hidden page pausing every element where it is and a shown one playing on; the Esc screen pausing every element (music, ambience, a one-shot, a voice) where it is and closing it resuming them; music and ambience playing on under the branch map, the voice pausing there and resuming when it closes; auto-forward waiting for the 8.4 s voice line past its text hold while it is audible, and holding only for the text with Voice at 0 (set by an imported progress file); the Volumes box: music and ambience pausing under the Esc screen and playing while the box is open (their clocks moving), nothing else playing, five presses of Music's - reading 50%, saved at once and halving the music and ambience elements' volume at once, Escape closing the box and pausing them again, and after a reload the music playing at the saved 50% with the box reading 50%; an Effects change playing the game's first one-shot at the new level when none has fired, else the last one fired (the 3 s bell) for at most 2 s, the item's own one-shots held; a Voice change playing the current item's voice line for at most 2 s while the line itself stays paused; `v` showing "Sound off", saving it at once and silencing every element, then "Sound on" with the screen's ambience back, turning sound on firing no one-shot (the siren gone, the pending bell dropped) and not restarting the voice line; the Esc screen's Sound switch showing `v`'s Off, `v` over the screen turning it On with its pill, a click turning it Off, which survives a reload with nothing playing and no hint; fixtures/demo making no `<audio>`, no `#audio` and no hint, with `current().audio` null, and `openGame`'s `current()` reporting the audio demo's target, `unlocked` and the music element playing |
| `videosound` | a video's own sound (docs/plan.md Phase 47 item 6) on fixtures/audio-demo's video (seconds 2-8 of its file, looping from 4, under a text chain; its `clock` track ducks the music to 0.3), each part opened at `#start=video-title` and read through `#audio`'s `video` slot against the stage's `<video>`: the video and its sound playing once the reader reads onto it, on the video's clock track; walking back onto it over seen content showing its poster with the sound silent, and a skip burst over it playing none; a skip burst with "Play videos in full" playing the video and its sound in step; the sound within 80 ms of the video across three range wraps once each seek has landed, with no more than two seeks a wrap, back within 80 ms after a seek of the video, and re-seeking when knocked 300 ms off; under the text chain the clip and its sound playing on, in step, never restarted; the music falling to the duck while the sound plays, staying there through a wrap and coming back to its level once the reader leaves; the Esc screen, the branch map and a hidden page each pausing the video and its sound, neither moving, and closing or showing resuming both in step. The demo's range ends at the file's end, so the parts wrap by `ended`; a range end inside the file and a native loop are covered by Vitest only |
| `branches` | decision firing, the ending route and its re-offer, the nested decision, the Return row rule, continuing-route join, resume inside branch content and the last picks surviving a reload, `e` to the furthest point read, walked choice screens (route highlighted) and real picks from them, the wheel leaving choices and passing through them both ways, scroll-back following the last pick (Route 2 then Route 1: Route 1's path only), an ending route stopping the walk, the ending hint, walking back before a decision after reading one route (the choice fires again, Route 2 still marked seen, Route 1 pickable), Tab and `a` on a choice screen (docs/plan.md Phase 43: each pill shown over the choice, nothing moving; skip turning off at the pick of an unseen route, and running a read route to its last item; auto-forward running the route after the pick), `index.html#start=<id>` (docs/plan.md Phase 46, each in a fresh profile: a main-line item, `chain-still`, named by the stage's `data-item` under the first-load Esc screen, Space reading on from it and a reload resuming where Space left off, with the hash gone and the resume notice back for that resume; 1a inside Route 1, `nest-continue`, opened with a query kept and no resume notice though everything before it is unread, Space joining `route1-end` and, after a reload there, the aftermath; the decision's item, `branch-decide`, where Space opens the choice; an unknown id giving exactly one console warning naming it and the usual first screen) |
| `playall` | Play all routes (on by default; the walks find it On on the Esc screen) with skip-all on one Tab (each choice shown and picked at once, no countdown, continuing route last), the on-screen countdown sized to every word on the screen plus comprehension time, with the next pick marked from its start, then the highlighted pick changing no word on #choice (status, seconds, hint stay as the countdown left them, first offer and re-offer), shortest route first, the re-offer's "Back in time: “<route>” is done." line, Space taking the pick, a digit picking another route, the continuing route's join with no choice, route pills (~1.6 s, no back pill after an auto-pick), no ending hint at play-all route endings, the Esc screen over a counting-down choice (countdown frozen, digits inert, restarted on close), `c` inert on it, walking back before the first decision after every route played (with Space and with auto-forward: the choice and its countdown show again and every route plays again in the same order, seen marks kept), Tab during a countdown ("Skip on" over the choice, the countdown unchanged, skip running the auto-picked read route to its last item, then "Skip off") |
| `branchmap` | the branch map (docs/plan.md Phase 31) on the demo after playing Route 2 through: `m` opens it with both decisions and four routes, marks (outer reached, nested faded and inert, Route 2 played and outlined as the last pick, Route 1 unseen), the "you are here" marker on Route 2's line; (Phase 40) decisions 52 x 28 and route pills 32 x 24 world units, their 13 px figures' digits centred within 0.25 px; (Phase 41) the first open at Full size (its half pressed), scale exactly 1, the demo shorter than the view so the wheel, a drag, the scrolling keys and + move nothing (and the drag clicks nothing); a drag or double click selecting no text; F switching to Fit with every node in view, clicks on the unreached nested decision and its route doing nothing, Esc returning to the game (not the Esc screen); the map reopening at Fit as it was left, a click on Route 1 there entering it at its first screen and closing the map, reading on reaching the nested decision; a click on the outer decision opening its choice screen with the last pick highlighted; the wheel over the open map leaving the story where it was; `m` on the Esc screen replacing it, Esc then back to the game; Fit filling the view or stopping at 3x centred at 1280x720, after resizes to 1920x1080, 2560x1440 and back (back to the same picture), and when opened at 2560x1440; the marker on the story's and Route 2's end marks when fully seen; Spoilers (off by default, no hidden text in the DOM, S and the button, the tree unmoved, surviving a reload); the marker's ring and label inside the view at Full size (after C) and at Fit, at the story's start and end, at 800x600 and 1920x1080; the header being the title and exactly the Spoilers, Newest bookmark and Centre buttons and the touching halves of "Full size \| Fit" (Full size pressed) hinting "shortcut: S/N/C/F/F" on one line at 800x600 and 1920x1080, each hint showing within a frame of a hover or keyboard focus; (Phase 41, two views, the demo with five bookmarks at 800x600) Full size with every card and line across the view and the scroll bar shown, the wheel scrolling by its delta while a sideways wheel and a ctrl+wheel (pinch) move nothing, Up/Down 80 px, Page Up/Page Down 0.875 of the view, Home/End the ends, Left/Right, +/-, 0 and 1 nothing, the scroll bar's thumb dragged 40 px scrolling in proportion and a press on its track paging, a drag of the map scrolling up or down only and opening nothing, then a click on a card (moving under 5 px) opening it; Fit not moving for the wheel, a drag, the scrolling keys or +, with no scroll bar; the header's halves and F switching views (the pressed half doing nothing); C and N switching from Fit to Full size centred on the marker and on the newest card; the remembered view: the first open Full size centred on the marker (C then changing nothing), a scrolled view reopening with the same transform after a close and after a reload, C then a scroll then C again making the next open (and the one after a reload) centre on the marker where the reader has got to, not the scrolled place, a resize at Full size keeping N's card in the middle, a resize at Fit fitting again and a Fit reopening as a fresh Fit for the window, a bookmark added since making a Full size open centre on the marker rather than the top it was scrolled to, and after Reset progress a Full size open with the marker's ring within 2 px of the start dot (at Fit too); (Phase 40, map lines) the lead-in's read stretch painting 5 screen pixels wide at Fit in 1280x720 (about 3x), Full size and Fit at 3x in 1920x1080, equal within half a step of `--line-px` (0.22 px) plus 0.5 px (measured from screenshot pixels with the rest of the map hidden), and `--line-px` set on the world group, whose only text is the decision figures (the counts and pill numbers outside it); (Phase 41, one look at every scale) on a 220-node tree built for the check (node groups from 0.6x), its first decision reached and route 1 the last pick, the window sized so Fit lands just above 0.6x (node groups) and just below (merged), the decision and the pill captured at 4x device pixels with the lines and marker hidden and compared on a 10 x 8 grid of mean colours over each node's ink box, the same within a mean of 0.03 and a worst cell of 0.2 (shares of 255), with a figure standing out of the fill on both; screenshots `.tmp/branchmap-shots/simp-*.png`, `views-*.png`, `lines-*.png`, `look-*.png` |
| `continueroute` | routes with `result: "continue"` (docs/plan.md Phase 38) on a folder of its own built from the demo's images (one decision: Negotiate and Pay continue, Contract is the continuing route, all into one shared scene): with Play all routes off, Pay's last item stepping straight to the shared scene with no choice screen between (a page-side log), one wheel notch back from the shared scene showing Pay's last item and one forward the shared scene; the branch map drawing the three routes as join lines into the decision's join, no return line and no end mark but the story's; with Play all routes on, Negotiate's end and Pay's end each re-offering the choice ("Back in time: “<route>” is done.") and Contract, played last, joining the shared scene; content added since (docs/plan.md Phase 39), on a second copy of the folder: Contract read through to the shared scene, the manifest (and manifest.js) rewritten with Contract extended by two items, the page reloaded, then one wheel notch back from the shared scene showing Contract's old last item (passing over the new unseen end), a notch forward staying there and Space reading on into the new item |
| `bookmarkmap` | bookmarks on the branch map (docs/plan.md Phase 35) on the demo with bookmarks taken by `b`: `t` doing nothing over the story, the Esc screen (no T row, 11 rows, M the only button, its M row reading "branch map and bookmarks") and the map; cards in story order along the line with their pictures, only the newest marked, the newest card centred on the "you are here" point for its screen and the others on the same line; the map opening at Full size (Phase 41), which shows them 280 px wide with their timestamps, none overlapping, each its 280 x 158 thumbnail alone (no caption strip, Phase 40; the newest outlined and labelled "(newest)"), the count line under them clear of the cards; Delete, Backspace and Enter doing nothing to a hovered card; in a 1280x400 window, where Full size scrolls, a drag that starts on a card scrolling up or down by the distance moved (never sideways) and opening nothing, and through 8 drags the view scrolling by each drag within the map's ends, each card moving with it, keeping its offset from the SVG, and the painted line running through the gap between two cards at their centre height (a screenshot read back pixel by pixel); a card click opening its bookmark; hovering a card at Full size and at Fit (a card, the newest, a ghost) showing the map tooltip whose whole text is the card's timestamp (Phase 36); at Full size a hovered card's × (24 px, its instant "Delete this bookmark" hint, no card tooltip over it), deleting into a ghost with the toast, no card tooltip over the ghost's Undo, the ghost's Undo, Z; at Fit (cards small: taken at 800x500, under 0.7x) the × still shown at 14-24 px in the card's corner, no card tooltip over it, a ghost a dashed outline of at least a screen pixel, a click on the ghost or the toast's Undo restoring it; a delete standing at close being final; the map reopening at Fit as it was left and a small card's click there opening it; screenshots `.tmp/bookmarkmap-shots/` |
| `storyid` | progress keyed by the manifest's `storyId`: a manifest without one stores under the folder URL (its seen records too, docs/plan.md Phase 46), adding the id carries progress, seen records and bookmarks over to `story:<id>` (folder-URL record and seen records gone), and a moved and renamed folder resumes where it was with its bookmark |
| `window` | the Esc screen's window controls (docs/plan.md Phase 43): under a recording host, for both `mac-app` and `windows-app`, keys and clicks never asking for element fullscreen, the switch showing the host's mode, the Window half sending `{ type: "display", mode: "window" }` with Fullscreen still pressed until the host switches, a host-side change moving the pressed half (with the screen open, and while closed), the pressed half sending nothing, a reload starting in the host's mode then in force, Exit sending `{ type: "quit" }`; in a tab, Escape never asking, a key asking while windowed and not while fullscreen, asking again after leaving fullscreen, Window leaving fullscreen and stopping the asking across a reload, Fullscreen asking at once, a click on a settings control asking nothing, a window the size of the screen asking nothing, a host that appears after load taking over; Exit saying to close the tab in the `#flash` pill where the page may not close it (no refused `window.close()`, nothing on the Esc screen moving), and closing a tab opened straight on the game (one history entry); held keys under the `mac-app` host (`harness.holdKey`: a keydown, five auto-repeats, a keyup): the page taking every keydown of Esc, Space and Tab, repeats included, and acting on the first alone (the Esc screen opening and staying open, Space closing it with the story unmoved), and leaving a held `z` alone; on WebKit, nothing of the held Esc, Space and Tab coming back to the app's window class, and the held `z` coming back, repeats included, and dropped there, never reaching NSWindow's own `keyDown`; ⌘H under the `mac-app` host (`harness.pressShortcut`) left by the page (not prevented) with the text still shown, and a plain `h` still taken and hiding the text; on WebKit, ⌘H offered to the window as a key equivalent, claimed by the web view for the page's turn and then handed back unclaimed (where the app's main menu is offered it), and dropped by the window |
| `creator` | the creators' testing library (`player/scripts/testing/kinetic.mjs`; CREATE.md, "Testing your game") on the run's engine: `openGame` at the first item with the Esc screen closed, `press("Space")` showing the next item's line and speaker, `waitForItem` by id and by a test (and giving up naming the screen), `spaceUntil` to an item and to a choice, `waitForChoice` with the rows, `spaceUntil` refusing to pass a choice with Play all routes off, `pickRoute(2)` entering route 2, `reload` and a reopen with a kept profile resuming there, a fresh open at the start with `closeHelp: false` leaving the first-load Esc screen for Space, a 1280x720 PNG screenshot, and `errors()` empty in every open of a whole folder (the library opens its own browsers, so this stands in for the console check). Two parts read the stage's `data-item` (docs/plan.md Phase 46): through a Space walk of the whole demo with Play all routes on it equals the item the screen's own line or picture names at every step, and `current()` names every step from it (`foundBy: "player"`); after the walk `checkMedia()` has followed every picture, video and poster shown and found none failed; under an open choice it names the item the choice is drawn over (the decision's `after` item, and the route's last item at a re-offer); the Esc screen and the map, opened over a chain line and over the first choice, leave it on the item beneath; an empty-manifest folder's stage has none; and a log kept in the page on every animation frame and after every DOM change, through text chains, picture changes, the animation, the videos and a choice into a route, never shows one item's line or picture with another item's id (a `data-item` set one frame late fails it). Four parts cover the rest of Phase 46 item 4, each on copies of the demo: an older player (a script added to the copy's index.html keeps `data-item` off the stage) on a copy where two items share a line, named from the screen (`foundBy: "screen"`) and the two told apart by the player's saved place in a walk and on a reopen (`"saved place"`); `openGame(folder, { startAt })` opening at `route2-start` with Space reading on, and refusing, with the reason and the fix, a player that ignores `#start=` (a script clears the hash first) and one with no `data-item`; a symbolic link out of the folder (in place of a shown picture) named in one `log` note, which WebKit cannot load through and Chrome can, and a link inside the folder loading on both with no note; a missing picture, an undecodable picture, an undecodable video and an undecodable video poster, each passed at check-game's pace (Space and `current()` with no pause, so the player replaces a picture or video before its load can fail, and a poster fires no event at all), giving exactly one `errors()` line each once `checkMedia()` has resolved (Chrome's own line for the missing file, the library's for the rest), and a page's `console.warn` listed once as `[warning]` |
| `checkgame` | the creators' quick check, `player/scripts/testing/check-game.mjs` (docs/plan.md Phase 46, item 5), run as a child process on the run's engine, its stdout, stderr and exit code read: `--steps all` on the demo stops with `story ended at step N` at the demo's last screen (N the step whose `  N: <summary>` line first showed it), every item visited, exit 0, the item lines as before, and a heartbeat on stderr (`check-game: step N; M items seen; on screen: ...`, its interval shortened through `KINETIC_CHECK_GAME_HEARTBEAT_MS`); `--steps 1000` stops at the same step (its heartbeat `step N of 1,000`) and `--steps 3` after 3 steps; a linear copy (no branches, so no end card) stops at its last item with each item in order; a copy where the outer decision is a pure choice running to the end stops on route 1's last item, before the manifest's last, by the end card alone; a copy with a text item between the last route's end and the join (no route reaches it; the validator accepts it) exits 3 naming it, and with a picture missing as well exits 1 naming the file; `--start-at route1-end` prints it as step 0 and `--until` stops when the demo's last item first shows; a walk from `--start-at` that reaches the end lists no items never shown (exit 0); an `--until` the walk never reaches exits 1; an id the manifest lacks, for either option, and a bad `--steps` exit 2 with no browser started; a copy whose page swallows Space after three presses is a stuck player (5 or more unchanged presses over 2 s or more), exit 1 naming the screen |
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
- Silent: WebKit has no fake output stream, so the driver mutes its page
  (`_setPageMuted:`). Media still plays, its clocks and events run, and
  the gesture rule holds; the muted output plays zeros. A driver that
  cannot mute stops the run.
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

## Listening checklist

Agents cannot hear, and every automated run is silent, so the scenarios
check the sound through the player's hook. This list is the check by ear,
on fixtures/audio-demo, in real Safari, in desktop Chrome and in a Mac app
built for the demo (docs/plan.md Phase 47, item 11). Each step names the
screen by its item id and the key to press, then what you should hear;
the demo's own lines say the same. Report each step that does not match,
with the engine.

### Setting up

From the repo root:

```sh
.venv/bin/python fixtures/build_audio_demo.py
(cd player && npm run build)
.venv/bin/python tools/assemble_folder.py --force fixtures/audio-demo ~/audio-demo-play --mac
```

The builder needs ffmpeg on PATH. `--mac` adds `Kinetic audio demo.app`
to the folder and needs Xcode or the Command Line Tools (CREATE.md,
"Building the apps"); leave it out to test the browsers alone. Open the
folder in each:

```sh
open -a Safari ~/audio-demo-play/index.html
open -a "Google Chrome" ~/audio-demo-play/index.html
open ~/audio-demo-play/"Kinetic audio demo.app"
```

- Set the Mac's volume to a comfortable level. Headphones make the hum
  and the rain easier to hear.
- In a browser, click Window under "Game window" on the first Esc screen.
  The page then stays in a window, so Esc always opens the Esc screen
  (Safari takes the first Esc to leave fullscreen) and a new tab opens as
  usual. The app stays fullscreen.
- Each browser and the app keep their own progress. To run the list
  again, open the Esc screen, click Reset progress and confirm: the page
  reloads as a first load, with sound on and every volume at 100% (in a
  browser, click Window again).
- Wait for each step's sound before the next key unless the step says
  otherwise. One mouse wheel notch, or a short two-finger swipe, moves
  one screen.
- Play all routes stays on, its default, so the decision counts down and
  picks for you.
- In the app every step is the same, except that sound plays from launch
  and the "Press any key for sound" pill never shows (steps 1 and 48).

### Reading through

- [ ] **1. Open: `intro-title`.** The Esc screen covers the first card.
  Its Keys card lists V, "sound on / off", after H, and its settings have
  a Sound row: Volumes... and a switch showing On. Silence, and no "Press
  any key for sound" pill, since nothing has tried to play yet. In a
  browser, click Window now.
- [ ] **2. Space.** The Esc screen closes. Silence.
- [ ] **3. Space -> `music-title`.** Silence.
- [ ] **4. Space -> `music-start`.** A calm tune fades in over about a
  second: slow, low notes, half a second each, rising and falling,
  looping every 8 s. Chrome may leave a seam of a few milliseconds at the
  loop; that is known and accepted. If not: say whether the pill showed.
- [ ] **5. Space -> `music-carry`**, a line over the same picture. The
  calm tune plays on without starting again. If not: it restarts from
  its first note.
- [ ] **6. Space -> `music-crossfade`.** Over 4 s the calm tune fades out
  while a brighter, faster tune of high notes fades in; midway you hear
  both.
- [ ] **7. Wait 5 s, Space -> `music-once`.** Within a quarter of a
  second the bright tune gives way to a fanfare: three short rising notes
  and a long ringing top note, about 3 s in all, then silence. It does
  not come back.
- [ ] **8. Space -> `music-partway`.** Groups of short beeps fade in, one
  group a second: three beeps a group for 3 s, then four a group, higher,
  for 3 s, then two a group, lower, then three, four and two again. You
  never hear single beeps: the track starts 6 s in and loops back to 3 s,
  both past them. Listen for 15 s to hear the loop.
- [ ] **9. Space -> `music-stop`.** The beeps fade out over 2 s. Silence.
- [ ] **10. Space -> `amb-title`.** Silence.
- [ ] **11. Space -> `amb-start`.** A soft hiss of rain and a low, steady
  hum fade in together over a second.
- [ ] **12. Space -> `amb-carry`.** Rain and hum play on unbroken.
- [ ] **13. Space -> `amb-shrink`.** The rain fades out over a second, and
  the hum plays on with no break or dip. If not: the hum restarts or
  dips.
- [ ] **14. Space -> `amb-stop`.** The hum fades out. Silence.
- [ ] **15. Space -> `sfx-title`.** Silence.
- [ ] **16. Space -> `sfx-delay`.** Silence, then 1.5 s after the line
  appears a double knock: two low thuds a fifth of a second apart.
  Nothing else.
- [ ] **17. One notch back -> `sfx-title`, then Space twice within a
  second.** The knock never comes; the second Space reaches
  `sfx-channel`, step 18.
- [ ] **18. `sfx-channel`.** A siren starts at once, wailing up and down
  once a second. After 2 s a bell rings, and the siren stops dead at that
  instant; the bell rings out for about 3 s. If not: the siren goes on
  under the bell.
- [ ] **19. When the bell has died away, Space -> `sfx-overlap`.** The
  same siren; after 2 s the bell rings while the siren keeps wailing to
  its end, 6 s after it started.
- [ ] **20. When the siren has ended, Space -> `voice-title`.** Silence. A
  one-shot plays to its end when you read on, so an early Space leaves it
  sounding here.
- [ ] **21. Space -> `voice-mei`.** Mei: three quick, high, rising
  chirps, once.
- [ ] **22. Space -> `voice-theo`.** Theo: two slower, lower, falling
  chirps, once.
- [ ] **23. Space -> `voice-long`.** Mei chirps for about 8 s, rising and
  falling in turn. After 2 s press m: the branch map opens and the chirps
  stop where they are. Press Esc: the map closes and the chirps carry on
  from there. Before they end, press Space -> `voice-after`: the chirps
  stop at once. Silence.
- [ ] **24. One notch back -> `voice-long`, then a.** After a quarter of a
  second the long chirps start again from the beginning; press a at once
  ("Auto-forward on"). The line waits for the chirps: `voice-after` shows
  as they end, about 8 s after they began, where the text alone would
  move on after about 6 s. Press Space ("Auto-forward off") to stay on
  `voice-after`. If not: the line moves on while she still chirps.
- [ ] **25. Space -> `branch-title`, nine notches back, then Tab.** The
  wheel takes you back to "Next: one-shots..." (`sfx-title`); resting on a
  voice line starts its voice, so keep turning. Tab: "Skip on", the skip
  runs over the one-shot and voice lines in about a second and stops back
  on `branch-title` with "Skip off". No knock, siren, bell or chirp sounds
  on the way. If not: name what sounded.
- [ ] **26. Space -> `branch-ask`.** Silence.
- [ ] **27. Space.** The choice "Which route's music?" opens with Route 2
  highlighted and a countdown; the silence goes on. Press Space to take
  Route 2 now, or let the countdown pick it.
- [ ] **28. `route-cold`.** A fast, high trill fades in over a second,
  softer than the tunes before.
- [ ] **29. Space -> `route-cold-2`.** The trill plays on.
- [ ] **30. Space.** The choice comes back, saying Route 2 is done, with
  Route 1 highlighted; the trill plays on under it. Press Space.
- [ ] **31. `route-warm`.** Over a second the trill crossfades into warm,
  slow, low bell notes, one a second, each ringing out.
- [ ] **32. Space -> `route-warm-2`.** The bells play on.
- [ ] **33. Space -> `branch-join`**, a scene that sets no music. The
  bells play on: Route 1 was read last.
- [ ] **34. Three notches back to the choice, then 2.** The bells play on
  over the route's two screens and fade out within half a second on the
  choice, where Route 1 is highlighted. Press 2: `route-cold`, and the
  trill fades in. Space -> `route-cold-2`. Space: the choice comes back,
  since Play all routes plays every route again. Press 0, "Return to main
  route": `branch-join` shows and the trill plays on, since Route 2 was
  read last. If not: the bells come back here.
- [ ] **35. Space -> `video-title`.** The trill plays on.
- [ ] **36. Space -> `video-sync`.** The video plays: a bar crossing
  between two walls on violet. Within a quarter of a second the trill
  drops to about a third of its level, and the video's own sound starts:
  a click each time the bar hits a wall, once a second, over a low steady
  tone. The colour goes violet, rust, blue, then rust and blue in turn,
  2 s each, and green never shows. The tone steps up with each colour and
  changes as the colour changes. If not: say how far the clicks drift
  from the wall hits, and in which engine.
- [ ] **37. Space -> `video-sync-2`.** The clip plays on under the line,
  clicks and tone in step and not starting over; the trill stays low.
- [ ] **38. Esc.** The Esc screen opens, and the video, its clicks and
  tone and the trill all stop where they are. Esc again: all resume, the
  clicks still on the wall hits.
- [ ] **39. Space -> `video-sync-3`.** As step 37.
- [ ] **40. Space -> `pin`.** The clicks and tone stop, and over 3 s the
  trill fades out while the calm tune and the rain fade in.
- [ ] **41. Space -> `end`.** The calm tune and the rain play on.

### The controls

- [ ] **42. Walking back.** From `end`, one notch: `pin`, and calm and
  rain play on. One more: `video-sync-3` shows the video's still frame,
  and after a quarter of a second the rain fades out and the calm tune
  crossfades into the trill at its full level, with no clicks. Turn back
  quickly over several screens: nothing changes while the wheel turns.
  Rest on "Mei chirps for about 8 seconds..." (`voice-long`): the trill
  fades out and her chirps start. Rest on "The same siren and bell with
  no channel..." (`sfx-overlap`): no siren and no bell, silence. Rest on
  "Rain and hum play on..." (`amb-carry`): rain and hum fade in. If not:
  a one-shot plays on a screen you walked back to.
- [ ] **43. e.** Back on `end`; after a quarter of a second the hum fades
  out, the rain plays on unbroken and the calm tune fades in.
- [ ] **44. v, then v.** "Sound off": calm and rain stop at once. "Sound
  on": they fade back in.
- [ ] **45. m, then Esc.** The branch map opens, and calm and rain play on
  under it. Esc closes it.
- [ ] **46. Esc, then Volumes...** Esc: calm and rain stop where they are.
  Click Volumes... in the Sound row: a box titled Volumes shows Music,
  Effects and Voice at 100%, and calm and rain play again while it is
  open. Click Music's - five times: 50%, and calm and rain drop to half
  loudness at once. Click Effects' -: 90%, and the bell, the last
  one-shot played, rings at that level for at most 2 s, then stops (after
  a reload it is the knock, the game's first one-shot). Click Voice's -:
  90%, and Mei's three rising chirps, the game's first voice line, play
  once, since `end` has none. Click each + back to 100%; Effects and Voice
  play their samples again. Esc: the box closes, and calm and rain stop
  again under the Esc screen. Esc: the screen closes and they play on.
- [ ] **47. A hidden page.** In a browser, Cmd+T opens a new tab: calm and
  rain stop. Close it with Cmd+W: they play on from where they stopped.
  In the app, click Window on the Esc screen, close the screen and click
  the window's yellow button: silence; click the app in the Dock: they
  play on; then choose Fullscreen again. If not: the sound goes on while
  the page is out of sight.
- [ ] **48. Cmd+R.** In a browser the page resumes on `end`, nothing
  plays, and "Press any key for sound" shows in a small pill at the top
  right; nothing on the screen moves for it. Press Esc: the Esc screen
  opens, still silent. Press Space: the screen closes, the pill goes, and
  calm and rain fade in. If Chrome plays at once with no pill, note it:
  Chrome may carry the page's earlier key over a reload, which the
  headless runs never see. In the app, calm and rain fade in a quarter of
  a second after the reload with no key and no pill; quit with Cmd+Q and
  open the app again, and they start the same way.
- [ ] **49. Five notches back to `video-title`, then Tab.** After a
  moment the trill plays at its full level. Tab: the skip runs over the
  video, showing its still frame, and stops on `end` within about a
  second with "Skip off". No click or tone sounds on the way; then the
  trill crossfades into calm and rain.

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

