# Kinetic

A browser player for kinetic visual novels: a simple alternative to Ren'Py. A novel is a self-contained folder of media plus the player; open its `index.html` in a browser. No install, no server, no network.

## Playing

* **Space**: next item. Manual is the default: one press, one item. In auto-forward, Space turns auto-forward off and stays on the item.
* **a**: auto-forward on/off (Space also turns it off). A brief pill says "Auto-forward on" or "Auto-forward off" each time the mode changes, whichever key changed it. Turning it on counts the time the item has already been on screen, so an item already read moves on at once. Items advance at the auto-forward speed set in **c**; animations play a few times, videos play out (or follow their loop count or display duration).
* **Mouse wheel**: roll back through exactly what you saw, in the order you saw it, choice screens included; roll forward again to where you were. Reading on from before a choice plays it again as the first time (routes already seen stay marked), so with play all routes every route plays again.
* **e**: jump to the end of what you have read.
* **u**: go to the next unseen content wherever it is: an unplayed route (entered as if picked) or content earlier in the story, such as a prequel added by an update. A resume shows a quiet notice when such earlier content exists.
* **Tab**: skip through content you have already seen, showing only first frames; it stops on the last seen item, and Space stops it on the current one. Two settings under "When Tab skips" change how it skips: "Skip unseen content too" lets it run through unseen content, and with "Play videos in full" on, videos play out during a skip and Space cuts one short.
* **h**: hide or show the text.
* **b**: bookmark the current moment. **t**: the bookmark list (thumbnails with times, newest at the bottom); click a thumbnail to continue from there; its x deletes it.
* **c**: settings: auto-forward speed (its note says it also times play-all's choice countdown), the two "When Tab skips" options (skip unseen content too, play videos in full), play all routes (its note says what turning it on does), and under "Progress": export, import and reset progress. The Progress note says it: progress saves in this browser automatically, and Export / Import are only for moving to another browser or machine. Export downloads `<storyId>-progress.json` (position, seen items, routes, bookmarks, settings); Import, on the other browser or machine, takes that file, refuses one from a different story, asks to confirm, replaces that browser's progress for the story and reloads where you were. Works anywhere, including over a choice (which waits underneath; a play-all countdown pauses until you close it) and over the key help (which it replaces). **c** or Esc closes it; a click outside its controls does not.
* **Esc**: key help, headed by the game's name when the manifest has a `title` (also shown on first load, before anything starts); Esc or Space closes it and resumes, and a click does not. In fullscreen the browser takes the first Esc to leave fullscreen.
* **1-9**: pick a route at a decision (or click it). **0**: "Return to main route", when that row is shown.

The player goes fullscreen on the first key press or click. Position, route history, bookmarks and settings are saved in the browser under the story's ID (the manifest's `storyId`), so moving or renaming the folder keeps them, and the next visit resumes on the screen you left. The browser tab shows the game's `title`.

## Content

* Images, animations (a few images looped) and videos in any format the browser plays (MP4, WebM, or MKV with VP9/AV1). Media fills the screen without stretching.
* Videos can set a loop count, a display duration, a start/end range (with that range's own poster), a loop restart point, and a minimum play time (in auto mode the dialogue over it waits for the clip). Several items can share one video file.
* Text over the picture: dialogue with the speaker's name, thoughts (drawn differently), and narration. A run of text items keeps the previous picture or video on screen, a video playing on.
* Branches: a decision shows a prompt and its routes; shared lead-in and aftermath play once. A route continues the story, comes back to the decision, or ends. After a route ends you can pick another, and "Return to main route" appears once the continuing route has been finished. Decisions can nest. Kinetic is an interaction-free kinetic game, so the "play all routes" setting is on by default: it plays every route, shortest first, with no interaction: each choice still shows with the route it will take highlighted, counts down long enough to read the whole screen, then picks for you; after a route ends, the choice's status line names it ("Back in time: “<route>” is done."). Space picks at once; a number picks another route. It picks even with auto-forward off: the reader still presses Space through the text, but no decision waits for an answer. Turn it off in `c` to choose every route yourself; that choice is saved, and Reset progress turns it back on.
* Seen tracking is per item and per route; skip, resume and `u` respect it. An ending shows a small end card: how many routes are still unseen, with `u` for the next one, or "You have seen everything.".

## Tools

* `converter/`: turns a Ren'Py project into this format. It reads `.rpy` scripts, decompiles `.rpyc` when no `.rpy` exists, and reads `.rpa` archives directly. Menus become branches only where their shape is clear.
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
* Title or menu screens: only the key help, bookmark list and settings screens exist, and starting jumps straight to content.
* Windowed play.
