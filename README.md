# Kinetic

A browser player for kinetic visual novels: a simple alternative to Ren'Py. A novel is a self-contained folder of media plus the player; open its `index.html` in a browser. No install, no server, no network.

## Playing

* **Space**: next item. Manual is the default: one press, one item. In auto-forward, Space turns auto-forward off and stays on the item.
* **a**: auto-forward on/off (Space also turns it off). A brief pill says "Auto-forward on" or "Auto-forward off" each time the mode changes, whichever key changed it. Turning it on counts the time the item has already been on screen, so an item already read moves on at once. Items advance at the auto-forward speed set on the **Esc** screen; animations play a few times, videos play out (or follow their loop count or display duration).
* **Mouse wheel**: move back and forward through the story in story order, from wherever you are (a bookmark too), through the content you have seen. At a branch it follows the route you picked last there; choice screens are steps it passes through, the route it takes highlighted. Forward stops at the furthest point you have read. Reading on from before a choice plays it again as the first time (routes already seen stay marked), so with play all routes every route plays again.
* **e**: jump to the furthest point you have read in the story.
* **u**: go to the next unseen content wherever it is: an unplayed route (entered as if picked) or content earlier in the story, such as a prequel added by an update. A resume shows a quiet notice when such earlier content exists.
* **Tab**: skip through content you have already seen, showing only first frames; it stops on the last seen item, and Space stops it on the current one. Two settings under "When Tab skips" change how it skips: "Skip unseen content too" lets it run through unseen content, and with "Play videos in full" on, videos play out during a skip and Space cuts one short.
* **h**: hide or show the text.
* **b**: bookmark the current moment. Your bookmarks are on the branch map (**m**), each a thumbnail sitting on the story line at the very place you took it, in story order (one inside a route sits on that route's line); the newest has a gold outline, and hovering one shows when you took it. Click a thumbnail to continue from there (dragging on one moves the map instead). Hover a thumbnail for its **×** (shown at every zoom, Fit included) to delete it: it stays as a dashed outline you can click to bring it back, and a "Bookmark deleted" note offers **Undo** (or press **Z**) until the map closes.
* **m**: the branch map: every decision as a small node showing how many of its routes you have played ("1/2", "?" before you reach it), its routes as numbered pills (played ones filled, unseen ones dashed; the route you picked last at each decision outlined in gold), the stretches between them as lines with their screen counts, your bookmarks on those lines (a stretch holding some grows to fit them side by side), a gold "you are here" marker, and decisions you have not reached yet faded. Hover a node or pill for its full text. Drag to move, the mouse wheel or a trackpad pinch zooms around the pointer, the arrow keys move and + / - zoom; **F** (or 0) fits the whole tree, **1** shows it at 100% (bookmarks at full thumbnail size), **C** recentres on where you are and **N** on your newest bookmark (the header's Fit, 100%, Centre and Newest bookmark buttons do the same; hover a button for its key). The first time it opens it shows the whole tree; after that it reopens where you left it, zoom and position, even after a reload (a Fit reopens as a Fit for the window's size; Reset progress, or adding or deleting a bookmark, goes back to the whole tree). **Spoilers** (the header button, or **S**) is off by default: until you reach a decision, its question and its routes' labels read "Decision not reached" and "Unseen route" (a decision you have reached shows all its routes, played or not); turn it on to see everything. The setting is kept like the Esc screen's settings and travels with exported progress. Click a decision you have reached to go to its choice screen, or one of its routes to play that route from its start (a pick, as on the choice screen); unreached ones do nothing. Esc or m closes it. On the Esc screen, m (or a click on its M entry) swaps that screen for the map, so the next Esc goes back to the game.
* **Esc**: the Esc screen, headed by the game's name when the manifest has a `title` (also shown on first load, before anything starts): the keys, laid out across the screen, then every setting: auto-forward speed (its note says it also times play-all's choice countdown), the two "When Tab skips" options (skip unseen content too, play videos in full), play all routes (its note says what turning it on does), and under "Progress": export, import and reset progress. The Progress note says it: progress saves in this browser automatically, and Export / Import are only for moving to another browser or machine. Export downloads `<storyId>-progress.json` (position, seen items, routes, bookmarks, settings); Import, on the other browser or machine, takes that file, refuses one from a different story, asks to confirm, replaces that browser's progress for the story and reloads where you were. Esc opens it anywhere, including over a choice (which waits underneath; a play-all countdown pauses until you close it); over the branch map, Esc closes the map. Click a setting to change it; Esc or Space closes the screen and resumes, and a click does not (Space closes it even with a setting's button focused). In fullscreen the browser takes the first Esc to leave fullscreen.
* **1-9**: pick a route at a decision (or click it). **0**: "Return to main route", when that row is shown. **↑ ↓** move a highlight over every row and **Enter** picks it, which reaches routes past 9. A list too long for the window scrolls inside the choice screen: with the pointer over it the mouse wheel scrolls the list; elsewhere on the screen the wheel moves through the story as usual.

The player goes fullscreen on the first key press or click. Position, seen content, routes (including the route last picked at each choice), bookmarks and settings are saved in the browser under the story's ID (the manifest's `storyId`), so moving or renaming the folder keeps them, and the next visit resumes on the screen you left. The browser tab shows the game's `title`.

## Content

* Images, animations (a few images looped) and videos in any format Safari and Chrome both play (for example H.264 MP4, WebM, or MKV with VP9). Media fills the screen without stretching.
* Videos can set a loop count, a display duration, a start/end range (with that range's own poster), a loop restart point, and a minimum play time (in auto mode the dialogue over it waits for the clip). Several items can share one video file.
* Text over the picture: dialogue with the speaker's name, thoughts (drawn differently), and narration. A run of text items keeps the previous picture or video on screen, a video playing on.
* Branches: a decision shows a prompt and its routes; shared lead-in and aftermath play once. A route continues the story, comes back to the decision, or ends. After a route ends you can pick another, and "Return to main route" appears once the continuing route has been finished. Decisions can nest. Kinetic is an interaction-free kinetic game, so the "play all routes" setting is on by default: it plays every route, shortest first, with no interaction: each choice still shows with the route it will take highlighted, counts down long enough to read the whole screen, then picks for you; after a route ends, the choice's status line names it ("Back in time: “<route>” is done."). Space picks at once; a number picks another route. It picks even with auto-forward off: the reader still presses Space through the text, but no decision waits for an answer. Turn it off on the Esc screen to choose every route yourself; that choice is saved, and Reset progress turns it back on.
* Seen tracking is per item and per route; skip, resume and `u` respect it. An ending shows a small end card: how many routes are still unseen, with `u` for the next one, or "You have seen everything.".

## Tools

* Making a game: CREATE.md covers writing a content folder by hand and converting a Ren'Py game (setup, converting, episodes, decoder hooks, your own converter, checking a folder with `rebuild`, and what to do when something fails).
* `converter/`: turns a Ren'Py project into this format. It reads `.rpy` scripts, decompiles `.rpyc` when no `.rpy` exists, and reads `.rpa` archives directly. Menus become branches only where their shape is clear. Media files are named by their content, and the same game converts to the same bytes on any machine whose pinned tools pass the self-test.
* Updating an existing game to a newer Kinetic replaces only its `index.html` and `app.js`; readers keep their progress (CREATE.md, "Upgrading to a newer Kinetic").
* Runs on macOS with nothing to install beyond a browser. Navigation shows content within 1/24 s (measured in `docs/perf.md`).

## The demo

`fixtures/demo` (built by `fixtures/build_demo.py`) is a guided tour: every line of its text explains what is on screen. Its sections:

* Spoken dialogue, a thought, narration, and a bare picture (try `h`).
* An animation: four pictures at 8 per second, shown twice.
* A video under a chain of text lines (the clip plays on), then a chain over a still picture.
* A one-second clip with a loop count of 3, then a WebM clip held for a set 4 seconds.
* Two ranges of one video file, the second repeating from a later restart point.
* A clip with a minimum play time that holds its short dialogue chain in auto mode.
* A decision: Route 1 continues the story and holds a nested decision (1a carries on, 1b comes back to the choice); Route 2 is an ending; both lead back to the choice, and finishing Route 1 reaches the shared aftermath.

## Not supported

* Audio.
* Title or menu screens: only the Esc screen (keys and settings) and the branch map (with the bookmarks) exist, and starting jumps straight to content.
* Windowed play.
