# Playing a Kinetic Game

How the Kinetic player behaves for a reader: every key, control, screen
and setting, in full. README.md is the short overview; CREATE.md is the
author's guide. This file records the intended behaviour, so a change to
the player changes this file in the same commit. The key list on the Esc
screen comes from the player's own key table
(`player/src/render/keys.ts`), and its words from the catalogue
(`player/src/i18n/en.ts`).

## Opening a game

A game is a folder. In a browser, double-click its `index.html`: it
plays from disk, with no install, no server and no network. A game may
also come as its own app beside the folder, `<title>.app` on a Mac and
`<title>.exe` on Windows (The apps, below).

The first time a game opens, and again after Reset progress, the Esc
screen shows before anything starts, listing the keys; Esc or Space
closes it and the story begins. After that a game resumes on the screen
you left. The browser tab shows the game's `title`.

In a browser the player goes fullscreen on the first key press or click
other than Esc or a ⌘, Ctrl or Alt shortcut, so that first key can
simply be Space; whenever you have left fullscreen, the next such key or
click goes back, unless Window is chosen on the Esc screen. It does not
when the window already fills the screen.

To look at one item without reading up to it, an author adds
`#start=<id>` to the page's address (CREATE.md, "Playing the folder").

## Reading

- **Space**: next item. Manual is the default: one press, one item. In
  auto-forward, Space turns auto-forward off and stays on the item.
- **h**: hide or show the text.

Text sits over the picture: dialogue with the speaker's name above it,
thoughts (drawn differently), and narration with no name. A run of text
items keeps the previous picture or video on screen, a video playing on.
A speaker can have colours of their own, one for the name and one for
the lines; a coloured thought stays italic and is drawn dimmer. A line
can carry emphasis (italic, bold, underline, strike-through) and line
breaks, written with Ren'Py's own text tags (`{i}`, `{b}`, `{u}`, `{s}`,
`{p}` and the rest); the tags that only time Ren'Py's typing (`{w}`,
`{nw}`, `{fast}`, `{cps}`) are left out.

Pictures, animations (a few pictures looped) and videos fill the screen
without stretching. A picture can dissolve in over the one before, or
fade through black. A transition never holds up the text: the line shows
at once, any key ends the transition and does its own job, and skip, the
wheel, jumps, a reload and a reduced-motion setting cut.

## Moving through the story

- **Mouse wheel**: move back and forward through the story in story
  order, from wherever you are (a bookmark too), through the content you
  have seen. At a branch it follows the route you picked last there;
  choice screens are steps it passes through, the route it takes
  highlighted. Forward stops at the furthest point you have read.
  Reading on from before a choice plays it again as the first time
  (routes already seen stay marked), so with Play all routes on every
  route plays again.
- **e**: jump to the furthest point you have read in the story.
- **u**: go to the next unseen content wherever it is: an unplayed route
  (entered as if picked) or content earlier in the story, such as a
  prequel added by an update. On a resume, when such earlier content
  exists, a quiet notice says so: "Earlier content you haven't seen -
  press U."

Navigation shows the new screen within 1/24 s (docs/perf.md).

## Auto-forward

- **a**: auto-forward on or off (Space also turns it off). A brief pill
  says "Auto-forward on" or "Auto-forward off" each time the mode
  changes, whichever key changed it.

Turning it on counts the time the item has already been on screen, so an
item already read moves on at once. It works on a choice screen too: the
choice waits for your answer, and the route you pick then plays in the
mode you set. Items advance at the auto-forward speed set on the Esc
screen; animations play a few times, and videos play out (or follow
their loop count or display duration). A video with a minimum play time
holds the dialogue over it until the clip has played that long. A voice
line you can hear holds auto-forward until it ends.

## Skip

- **Tab**: skip through content you have already seen, showing only
  first frames. It stops on the last seen item, and Space stops it on
  the current one.

A brief pill says "Skip on" when it starts and "Skip off" whenever it
stops, however it stops. Tab with nothing seen ahead, or at the end of
the story, does nothing and shows nothing. A skip stops at a choice; Tab
on a choice screen turns skip on (or off) without answering it, and once
you pick, it skips through the route if you have read it before (or says
"Skip off" if there is nothing seen to skip). Skip changes no sound
until it stops.

Two settings under "When Tab skips" on the Esc screen change how it
skips: "Skip unseen content too" lets it run through unseen content, and
with "Play videos in full" on, videos play out during a skip and Space
cuts one short.

## Camera views in one video

- **← →** (Left and Right): on a video that marks several camera views
  (`segments`), after its last line, Space shows the views one by one
  before it moves on; Right steps to the next view without ever leaving
  the item, and Left to the view before. Each step shows "View n of m"
  in a brief pill. Elsewhere, and in auto-forward or skip, the arrows do
  nothing.

## Decisions

A decision shows a prompt and its routes; a shared lead-in and aftermath
play once. A route continues the story, comes back to the decision, or
ends. After a route ends you can pick another, and "Return to main
route" appears once the continuing route has been finished. Decisions
can nest. A route already played is marked "seen".

- **1-9**: pick a route (or click it).
- **0**: "Return to main route", when that row is shown.
- **↑ ↓** move a highlight over every row and **Enter** picks it, which
  reaches routes past 9.

A list too long for the window scrolls inside the choice screen: with
the pointer over it the mouse wheel scrolls the list; elsewhere on the
screen the wheel moves through the story as usual.

### Play all routes

Kinetic plays interaction-free kinetic novels, so the "Play all routes"
setting is on by default. It plays every route, shortest first, with no
interaction: each choice still shows, with the route it will take
highlighted, counts down long enough to read the whole screen ("Play all
routes picks in n s"), then picks for you. After a route ends, the
choice's status line names it ("Back in time: “<route>” is done.").
Space picks at once, ending any skip; a number picks another route. It
picks even with auto-forward off: you still press Space through the
text, but no decision waits for an answer. The auto-forward speed also
times the countdown. Turn it off on the Esc screen to choose every route
yourself; that choice is saved, and Reset progress turns it back on.

### Seen content and the end card

Seen tracking is per item and per route; skip, resume and `u` respect
it. An ending shows a small end card: how many routes are still unseen,
with `u` for the next one, or "You have seen everything.".

## Bookmarks

- **b**: bookmark the current moment. A brief pill says "Bookmarked".

Your bookmarks are on the branch map (**m**), each a thumbnail sitting
on the story line at the very place you took it, in story order; one
inside a route sits on that route's line. The newest has a gold outline,
and hovering one shows when you took it. Click a thumbnail to continue
from there (dragging on one scrolls the map instead).

Hover a thumbnail for its **×** (shown in both views, Fit included) to
delete it. It stays as a dashed outline you can click to bring it back,
and a "Bookmark deleted" note offers **Undo** (or press **Z**) until the
map closes; once the map closes the deletes are final.

## The branch map

- **m**: open or close the branch map. Esc closes it too.

The map shows:

- every decision as a small node showing how many of its routes you have
  played ("1/2", "?" before you reach it);
- its routes as numbered pills, played ones filled and unseen ones
  dashed, the route you picked last at each decision outlined in gold;
- the stretches between them as lines with their screen counts;
- your bookmarks on those lines (a stretch holding some grows to fit
  them side by side);
- a gold "you are here" marker;
- decisions you have not reached yet, faded.

Hover a node or pill for its full text. Click a decision you have
reached to go to its choice screen, or one of its routes to play that
route from its start (a pick, as on the choice screen); unreached ones
do nothing.

### Full size and Fit

The map has two views, picked with the header's **Full size | Fit**
button (the lit half is the view on show) or **F**, which switches:

- **Full size** shows your bookmarks at full thumbnail size with the map
  wrapped to the window's width, and scrolls up and down: the mouse
  wheel or trackpad, the scroll bar at the right, dragging the map, the
  up and down arrows, Page Up / Page Down, Home and End.
- **Fit** shows the whole map at once, as large as fits the window, and
  stays still.

Nothing zooms or moves sideways. **C** shows Full size centred on where
you are and **N** centred on your newest bookmark; the header's Centre
and Newest bookmark buttons do the same (hover a button for its key).

The first time the map opens it is Full size, centred on where you are.
After that it reopens in the view you left it in and, at Full size,
where you scrolled to, even after a reload. If your last move there was
**C** it centres on where you are again, wherever that is by then, as it
does after Reset progress or after adding or deleting a bookmark.
Resizing the window rewraps the map: Full size keeps what was in the
middle of the window there, and Fit fits again.

### Spoilers

**Spoilers** (the header button, or **S**) is off by default: until you
reach a decision, its question and its routes' labels read "Decision not
reached" and "Unseen route" (a decision you have reached shows all its
routes, played or not). Turn it on to see everything. The setting is
kept like the Esc screen's settings and travels with exported progress.

### Sound under the map

Music and ambience play on under the map; a voice line pauses until it
closes. On the Esc screen, **m** (or a click on its M row) swaps that
screen for the map, so the next Esc goes back to the game.

## The Esc screen

- **Esc**: open the Esc screen, anywhere, including over a choice (which
  waits underneath; a play-all countdown pauses until you close it).
  Over the branch map, Esc closes the map.

Esc or Space closes the screen and resumes, and a click does not (Space
closes it even with a setting's button focused). Click a setting to
change it.

The screen is headed by the game's name when the manifest has a `title`,
followed, smaller, by the game's `version` when it has one. Kinetic's
own version sits small in the bottom-right corner. In a game with
several languages the title bar also has the Language control
(Languages, below).

Below the heading are the keys, laid out across the screen, then every
setting.

### Keys

The key list names Space, ← →, the wheel, E, U, Tab, A, H, V (in a game
with sound), B, M, Esc, and the decision keys 1-9, 0, ↑↓ and Enter, each
with one short line. The M row is a button: a click opens the branch map
in the screen's place.

### Settings

- **Auto-forward speed**, shown as the multiplier and the time each
  character gets (`1.00x (~60 ms/char)`), with - and + buttons and a
  slider. Its **?** says it also times play-all's choice countdown.
- **When Tab skips**: "Skip unseen content too" and "Play videos in
  full", each an On / Off switch (Skip, above).
- **Play all routes**, an On / Off switch. Its **?** says what turning
  it on does: "When on, choices pick themselves on a countdown."
- **Sound**, in a game with sound: an On / Off switch (the same setting
  as **v**) and **Volumes...** (Sound, below). A game with no sound has
  no Sound row.
- **Progress · saved automatically**: Export, Import and Reset (below).
- **Game window**: a **Fullscreen | Window** switch and **Exit**
  (below).

Hover over a **?** or give it keyboard focus to read its note; a click
or tap keeps it open or shuts it. Nothing on the screen moves when a
pill shows.

### Progress

Progress saves as you read; Export and Import are only for moving it to
another browser or machine. The Progress **?** says so: in a browser,
"Saved in this browser as you read. Export and Import carry it to
another browser." In a game app (the Mac app, the Windows program) the
player never names a browser: the note reads "Saved as you read. Export
and Import carry it to another device.", and the Import button, its
confirmation box and its failure notice say "the progress saved here" or
"this computer's storage" instead of "this browser".

- **Export** downloads `<storyId>-progress.json` (position, seen items,
  routes, bookmarks, settings) and says "Progress exported" in a pill at
  the top of the screen, naming no file, since the browser or the app
  may save it under another name (the Windows program's `name
  (2).json`).
- **Import...**, on the other browser or machine, takes that file. It
  refuses one from a different story (the pill says why, and stays a
  little longer), asks to confirm, replaces that browser's progress for
  the story and reloads where you were.
- **Reset...** asks to confirm (**y** resets; Esc or **n** cancels),
  then clears the resume position, seen items, routes, bookmarks and
  settings for this game.

### Game window

**Fullscreen | Window** shows how the game is displayed now (the lit
half), and **Exit** ends the game.

- In a browser, Window leaves fullscreen and stays out of it, Fullscreen
  goes back, and the choice is kept with the other settings. Exit closes
  the tab when the browser lets a page do that (a tab opened straight on
  the game); otherwise a pill asks you to close it. In fullscreen in
  Chrome or Edge, Esc still opens the Esc screen, and holding Esc leaves
  fullscreen; Safari and Firefox take the first Esc to leave fullscreen.
- In the Mac app, the switch changes the game's window (the green button
  and ⌃⌘F do too, and the switch follows them; no other key leaves
  fullscreen, so holding Esc only opens the Esc screen). The app reopens
  the way you left it, and Exit quits.
- The Windows program does the same with its own window (F11 switches
  too, and the switch follows it; no other key leaves fullscreen there
  either), and its Exit closes the game.

## Sound

A game's sound is optional: music that crossfades when it changes,
ambience loops (several at once), one-shot effects (delayed, or cutting
each other off on a named channel), voice lines, and a video's own
soundtrack, played in step with the clip and lowering the music while it
plays. Videos themselves stay muted.

- **v**: sound on or off, in a game with sound; a brief pill says "Sound
  on" or "Sound off". Turning it back on plays the screen's music and
  ambience again, but not its one-shots, and a voice line that was
  playing stays silent. The setting is kept with the Esc screen's
  settings. In a game without sound, v does nothing and the Esc screen
  lists no V row.

What plays follows the way you read: after a decision you hear the music
of the route you read last. A wheel step or a jump plays the music,
ambience and voice line of where you stop once you rest there for a
quarter of a second, never its one-shots; skip changes no sound until it
stops.

### Volumes

**Volumes...** on the Esc screen opens a small box over the screen with
a **-** slider **+** row for each kind of sound the game has, in steps
of 10%: Music (music or ambience), Effects (one-shots or a video's
sound) and Voice (recorded voice lines, or lines the app can speak). A
change is heard at once and saved. Music and ambience play while the box
is open, an Effects or Voice change plays a sample of at most 2 s at the
new level, and Esc, Done or a click outside closes the box alone.
Otherwise all sound pauses while the Esc screen is open and plays on
when it closes.

### When sound starts

In a browser the player plays no sound before the first key or click
other than Esc or a ⌘, Ctrl or Alt shortcut, whatever the browser would
allow. After each load or reload a game with sound shows "Press any key
for sound" in a small pill until then, and that key still does its own
job. The Mac app plays sound from the start; the Windows program asks
WebView2 to do the same (not yet verified on Windows). Sound pauses
while the page is hidden (another tab in front, or the window
minimised).

## Spoken lines

In the Mac app and the Windows program, a game that gives its characters
voices has every line spoken in its speaker's voice, generated on the
reader's computer while they read, a few lines ahead. Lines with no
speaker use a narrator voice. A recorded voice line always plays
instead, and a game whose every line is recorded offers no download.

The reader opts in with a one-time download of the voice model: about
3.3 GB on a Mac with Apple silicon and macOS 14 or later, about 6.8 GB
on a Windows PC with an NVIDIA card and driver 570.65 or later. The
model is shared by every Kinetic game on that computer. In the Volumes
box a **Download voice model** button stands in for the Voice slider,
with a **?** explaining it; on any other machine the button is greyed
out and its **?** says why. Once installed, a small **Remove voice
model** button beside the Voice label removes it, after a confirmation.
There is no on/off switch: the Voice volume controls the lines, and at 0
none are made.

A browser plays a game with unrecorded voices silently. Spoken lines
follow the language shown.

## Languages

A game can come in several languages in one folder. It opens in your
system language when it has it, and the Esc screen's title bar then has
a Language control (a globe and the language's name) that switches at
any moment, keeping your place, picks and bookmarks. A line not yet
translated shows in the original.

The player's own words (the Esc screen and its notes, pills,
confirmation boxes, choice hints, the end card, the branch map and the
Mac app's menus) come in 39 languages and follow your system language
when it is one of them, else English. The Language control changes the
story only, and a game cannot set them. Under Arabic, Persian, Hebrew
and Urdu the screens read right to left. The 38 besides English are
unreviewed drafts; corrections are welcome (docs/verify-player.md, "The
player's words"). Authors and translators: CREATE.md, "Translating a
game".

To have the player's words in another language, change the language
your computer, app or browser asks for, then reopen the game:

- **Mac app:** System Settings, General, Language & Region. Put the
  language first under Preferred Languages for the whole Mac, or under
  Applications click + and pick the game's app and a language for it
  alone.
- **Windows app:** the Windows display language (Settings, Time &
  language, Language & region), which needs a sign-out to take effect.
  The exe has no language setting of its own.
- **Browser:** the browser's preferred languages, most wanted first
  (Chrome and Edge: Settings, Languages; Firefox: Settings, General,
  Language). Safari follows the Mac's languages, or its own entry under
  Applications as for the Mac app.

## Keys the player leaves alone

A key held with ⌘, Ctrl or Alt is not one of the player's keys: the
player leaves it to the browser or the app (in the Mac app ⌘Q quits and
⌘R reloads). A key held down acts once, not on each repeat, with two
exceptions: ↑ ↓ keep moving the highlight on a choice screen, and the
map's scrolling keys keep scrolling.

## Saving and resuming

Position, seen content, routes (including the route last picked at each
choice), bookmarks and settings are saved as you read, under the story's
ID (the manifest's `storyId`), so moving or renaming the folder keeps
them, and the next visit resumes on the screen you left. In a browser
they are saved in that browser; the apps keep them on the computer.
Export and Import on the Esc screen move them to another browser or
machine.

## The apps

An author can ship a game as its own app beside the folder:
`<title>.app` for a Mac with Apple silicon and `<title>.exe` for 64-bit
Windows (WebView2, which Windows provides). Each plays the same folder
in its own window, with no browser. Both start fullscreen, reopen the
way the reader left them, and leave Esc to the game. They differ from a
browser in these ways:

- sound plays from the start (Sound);
- the Fullscreen | Window switch and Exit act on the app's window (The
  Esc screen, "Game window");
- the progress notes name no browser (The Esc screen, "Progress");
- spoken lines can be generated (Spoken lines).

Authors build them with `kinetic apps` (CREATE.md, "Building the apps").

## What a game can show

- Images, animations and videos in any format both Safari and Chrome
  play (for example H.264 MP4, WebM, or MKV with VP9). Images may be
  JPEG XL, which needs Chrome or Edge 117+, Safari 17+ or Firefox 133+.
- Videos can set a loop count, a display duration, a start/end range
  (with that range's own poster), a loop restart point, a minimum play
  time (in auto mode the dialogue over it waits for the clip), and
  camera views in one file that the reader steps through after the
  lines. Several items can share one video file.
- Sound tracks are MP3, M4A (AAC), WAV, FLAC or WebM (Vorbis or Opus).
- docs/content-format.md specifies all of it.

## No title or menu screens

Kinetic has no title, menu or credits screen of its own: only the Esc
screen (keys and settings) and the branch map (with the bookmarks)
exist, and opening a game goes straight to its first item. A title card,
credits and content warnings are image and text items at the start or
end of the story (CREATE.md, "Title, credits and content warnings").

## The demos

`fixtures/demo` (built by `.venv/bin/python fixtures/build_demo.py` in a
checkout) is a guided tour: every line of its text explains what is on
screen. Its sections:

- Spoken dialogue, a thought, narration, and a bare picture (try `h`).
- An animation: four pictures at 8 per second, shown twice.
- A video under a chain of text lines (the clip plays on), then a chain
  over a still picture.
- A one-second clip with a loop count of 3, then a WebM clip held for a
  set 4 seconds.
- Two ranges of one video file, the second repeating from a later
  restart point.
- A picture that dissolves in, a speaker with colours of her own, italic
  and bold from text tags, and a fade through black.
- A clip with a minimum play time that holds its short dialogue chain in
  auto mode.
- A decision: Route 1 continues the story and holds a nested decision
  (1a carries on, 1b comes back to the choice); Route 2 is an ending;
  both lead back to the choice, and finishing Route 1 reaches the shared
  aftermath.

`fixtures/demo` has no sound, so it shows no sound controls.
`fixtures/audio-demo` (built by `.venv/bin/python
fixtures/build_audio_demo.py`, which needs ffmpeg on PATH) is a guided
tour of sound: every line says what you should hear at that moment.
Assemble it with the player like any folder (`kinetic assemble
fixtures/audio-demo audio-demo-play`) and open `index.html`;
docs/verify-player.md, "Listening checklist", walks it step by step. Its
sections:

- Music: a calm tune fades in and carries over a line that sets none; a
  4-second crossfade to a brighter tune; a fanfare that plays once and
  stops; a track that starts partway and loops back to an earlier point;
  a 2-second fade to silence.
- Ambience: rain and a hum start together; the rain fades out while the
  hum plays on unbroken; then the hum stops.
- One-shots: a knock 1.5 s after its line; a siren cut off by a bell on
  the same channel; the same two with no channel, overlapping.
- Voice lines (chirps, since no speech can be generated): two speakers
  on a chain of lines, then a line whose 8.4 s voice outlasts its text,
  so auto-forward waits for it.
- A decision whose two routes set different music and join in a scene
  that sets none, where you hear the route you read last.
- A video playing a range of its file with a loop restart point, its own
  sound in step with it and lowering the music, under a chain of lines.
- A closing scene that sets both music and ambience, so it sounds the
  same after either route.

`fixtures/voice-demo` (built by `.venv/bin/python
fixtures/build_voice_demo.py`) is a small game whose characters have
voices (CREATE.md, "Giving characters voices").

`fixtures/showcase-demo` (built by `.venv/bin/python
fixtures/build_showcase_demo.py`) is the short story README.md's
screenshots come from: three decisions in a row, so one partial reading
shows a decision fully played, one partly played and one not reached.
