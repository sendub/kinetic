# Kinetic

A simple alternative to Ren'Py for playing kinetic visual novels.

Gameplay features:
* Display an ordered sequence of images, "animations" (a handful of images intended to be viewed in sequence multiple times) and videos. Media is scaled to fill the screen as much as possible without changing its aspect ratio. Videos may be any file the browser can play (e.g. MP4, WebM, or MKV with VP9/AV1); short videos can set a loop count and/or an explicit display duration, like animations. A video can also specify a start and end time and play/loop within that range, with its poster being the first frame of the range; a loop restart time can make the first pass play the full range while later passes restart partway through, keeping dialogue over it uninterrupted. Different items may use different ranges of the same file, and dialogue in an item's chain continues the playback rather than restarting it. A video can optionally set a minimum play time; dialogue over it still advances at reading speed, but in auto mode the player waits at the end of that dialogue chain until the video's requested time has elapsed before changing the visual, while manual advance and skip stay immediate.
* Support author-defined branches: a decision point shows a short prompt and a list of routes; shared lead-in and aftermath play once rather than per route. After a route finishes, offer to replay another route or continue the main route; a route without convergence declares an explicit return-to-main or an ending instead of a forced join. A "Play all routes" config option shows everything with zero interactivity. Seen tracking, skip-unseen, bookmarks, and resume are route-aware: seeing a decision never marks its routes seen, and a decision inside a route works too.
* Overlay text on the images, hideable with the "h" key. Text is either dialogue spoken by a character or unspoken thoughts of a character; the two read differently.
* Advance through the content one by one by pressing the space bar.
* Browse through the content manually, advancing with the space key (or wheel), or let it advance through the content automatically at a configurable reading speed when "a" is pressed, with animations shown a few times automatically, and videos played out once unless they set a loop count or an explicit display duration.
* Advance through the content at a rapid fixed speed, showing only the first "frame" of animations and videos, by pressing the tab key to skip. Does not skip past previously unseen content, unless a "skip all" config option is enabled.
* Show a summary of the keys on first load and hold there, the story starting only when the reader closes it, and press the escape key any time to pause and show that summary on a black screen (press it again to resume where things left off). While the player is fullscreen the browser takes the first escape keypress to leave fullscreen, so it cannot be relied on to reach the player; windowed escape works directly.
* Bookmark at any point by pressing "b", appending to a timestamped list of thumbnails of the content visible when b was pressed.
* Press "t" to bring up the scrolling list of bookmark thumbnails (scrolled to the bottom, most recent thumbnail visible). Clicking a thumbnail continues the novel from that time point. Pressing "e" returns to the time point of the first not-yet-seen content. Loading the game resumes where it was left off, route context included; the first ever load starts on the first image in the sequence. Bookmarks, resume state, and settings persist across sessions in browser storage (IndexedDB).
* Scroll wheel can roll back in time, showing sequence in reverse order from current time point, and scroll the other way can bring us back in the correct order, but not to unseen content.
* Press "c" to open a config screen.

Other features:
* Extractor/converter of raw content from Ren'Py projects to our format: it parses .rpy scripts, decompiles .rpyc when no .rpy twin exists, and reads .rpa archives directly, so packed games need no unpacking; Ren'Py menus become branches only where the shape is conservatively detectable, never a guessed join.
* A novel is a self-contained folder: the player bundle sits beside the content and its media, and opening index.html plays it in the browser, with no server and no network at play time.
* macOS compatible, free of runtime dependencies except possibly browser-related stuff if we use a browser for display.
* Fast to load: either not needing to be verified by macOS gatekeeper, or the core part that needs checking is tiny and the content doesn't need checking.
* Fast to view content and scroll back and forth, bookmark and jump to bookmarked timepoints. Never a delay to view content longer than 1/24th of a second.

Non-features:
* Audio support.
* Splash screens, title screens, menu screens other than the key-help, bookmark, and config screens; apart from the first-load key summary, starting the game jumps straight to content.
* Window mode. (Always fullscreen)
