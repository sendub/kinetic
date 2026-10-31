# Kinetic

A simple alternative to Ren'Py for playing kinetic visual novels.

Gameplay features:
* Display an ordered sequence of images, "animations" (a handful of images intended to be viewed in sequence multiple times) and videos.
* Overlay text on the images, hideable with the "h" key.
* Advance through the content one by one by pressing the space bar.
* Advance through the content automatically at a configurable reading speed, with animations shown a few times automatically, and videos played out once.
* Advance through the content at a rapid fixed speed, showing only the first "frame" of animations and videos, by pressing the tab key to skip. Does not skip past previously unseen content, unless a "skip all" config option is enabled.
* Bookmark at any point by pressing "b", appending to a timestamped list of thumbnails of the content visible when b was pressed.
* Press "t" to bring up the scrolling list of bookmark thumbnails (scrolled to the bottom, most recent thumbnail visible). Clicking a thumbnail continues the novel from that time point. Pressing "e" returns to the time point in the novel immediately before the next unseen content. This is also the state the game starts at when loaded (except for first ever load, which starts on the first image in the sequence).
* Scroll wheel can roll back in time, showing sequence in reverse order from current time point, and scroll the other way can bring us back in the correct order, but not to unseen content.
* Press "c" to open a config screen.

Other features:
* Extractor/converter of raw content from Ren'Py format files to our format.
* macOS compatible, free of runtime dependencies except possibly browser-related stuff if we use a browser for display.
* Fast to load: either not needing to be verified by macOS gatekeeper, or the core part that needs checking is tiny and the content doesn't need checking.
* Fast to view content and scroll back and forth, bookmark and jump to bookmarked timepoints. Never a delay to view content longer than 1/24th of a second.

Non-features:
* Audio support.
* Splash screens, title screens, menu screens other than the bookmark and config screens; starting the game jumps straight to content.
* Window mode. (Always fullscreen)
