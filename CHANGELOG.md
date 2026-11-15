# Changelog

What each Kinetic release changed, newest first, for authors and
readers. The player, the Mac and Windows game apps, the Ren'Py
converter and the author tools share one version.

Every closed phase of work is a release. A release that only fixes
things raises the patch number (1.7.0 to 1.7.1); one that adds a
feature or a new optional manifest field raises the minor number (1.7.0
to 1.8.0); one that stops existing game folders or saves working raises
the major number (2.0.0), and only that changes the manifest's
`schemaVersion`. Between releases the version reads as the next release
with `-dev`. Releases before 1.8.0 were numbered before these rules were
written, so their numbers do not always follow them.

Taking a new release means replacing a game folder's player (CREATE.md,
"Upgrading to a newer Kinetic"). Bullets marked **Upgrading:** ask
something more of an author.

## 1.9.0-dev

- Spoken lines (in progress; the Mac app first, the Windows program
  next): a game can give its characters voices, and the reader's Mac
  speaks each line in its speaker's voice, generated while they read.
  A reader opts in on the Esc screen's **Spoken lines** row with a
  one-time download of about 3.3 GB (Apple silicon, macOS 14 or later),
  shared by every Kinetic game on the Mac, and can remove it there.
  Lines are made at about half their length, the next ones ahead of the
  reader, and kept so a reread is instant. Auto-forward waits for a line
  still being made, up to 20 seconds. Thoughts are spoken in their
  speaker's voice, lines with no speaker in a narrator voice, and a
  recorded voice line always plays instead. A browser plays such a game
  silently.
- New optional manifest fields `voices` and `narrator` give each speaker
  a reference clip to clone (docs/content-format.md, "Voices"). The
  validator checks their files and scripts and warns about a voice nobody
  uses. `tools/assemble_folder.py` ships the clips' scripts and leaves
  the clips out, as for tracks. Older players ignore both fields.
- `tools/cast_voices.py` casts the voices: `design` makes several takes of
  each character from a written description (Qwen3-TTS VoiceDesign, on an
  Apple silicon Mac, with its packages in a separate `.venv-voice` from
  `requirements-voice.txt`) and a listening page, `pick` ships the take
  you chose and writes the manifest, and `record` ships your own
  recording. CREATE.md has a new section, "Giving characters voices".
- `fixtures/voice-demo`, built by `fixtures/build_voice_demo.py`, is a
  short story with two characters and a narrator to try spoken lines on.
- **Upgrading:** nothing is needed for a game without voices. To give a
  game voices, upgrade its player (`tools/upgrade_folder.py`), cast the
  voices and build the Mac app again.

## 1.8.0 (2026-11-15)

Release basics.

- Kinetic is MIT licensed (`LICENSE`). The notice travels in what an
  author ships: every built `app.js` and `index.html` opens with it, the
  Mac app carries it in its Resources and its Get Info line, and the
  Windows program in its resources beside the Go runtime's BSD notice.
  An author owes nothing beyond shipping the files as built.
- Kinetic's version is easy to find: small and dim in the bottom-right
  corner of the Esc screen, below the sheet (`Kinetic 1.8.0`), at the
  top of `app.js` and `index.html`, from `--version` on
  `kinetic-extract`, `kinetic-media`, `check-game.mjs` and the `tools/`
  scripts, and in check-game's first line, which names the folder's
  player version (`unknown` for an older player). Built apps record the
  version that built them.
- A game can state its own version: the optional manifest field
  `version` (plain text, 1 to 40 characters) shows after the title on
  the Esc screen, smaller and dimmer. kinetic-extract fills it from the
  Ren'Py `config.version` string, or from `--game-version TEXT`. Older
  players ignore the field.
- Editors can check a `manifest.json` as you type: the manifest accepts
  a top-level `"$schema"`, and kinetic-extract writes a copy of the
  schema, `manifest.schema.json`, beside the manifest and points at it.
  `tools/assemble_folder.py` leaves the copy out of the folder readers
  get. docs/content-format.md, "Schema version", says when
  `schemaVersion` changes.
- `tools/upgrade_folder.py <folder>` upgrades a game folder's player in
  one step: it copies only `index.html` and `app.js` from the built
  player, refreshes the folder's schema copy when it has one, runs the
  validator and prints `Kinetic <old> -> <new>`. It never touches
  `manifest.json`, `manifest.js` or the apps, and refuses a built player
  that is missing or of another version than the checkout (run `npm run
  build`).
- This changelog.
- **Upgrading:** use `tools/upgrade_folder.py` in place of copying the
  player files by hand. To show a game's version, add `version` to its
  manifest or convert it again. To have your editor check a
  hand-written manifest, copy docs/content-schema.json into the folder
  as `manifest.schema.json` and add `"$schema":
  "./manifest.schema.json"` (CREATE.md, "Manifest").

## 1.7.0 (2026-11-15)

Video loops at a file's end in WebKit.

- In Safari and the Mac app, a video whose pass runs to the end of its
  file loops every time, as in Chrome; before, it looped once and then
  stayed on its last frame. A range that ends past the last frame
  completes at the file's end.
- A camera view stepped to from a video held at its file's end plays
  from the view's start.
- A video held at its end stays held when the Esc screen or the branch
  map closes over it (WebKit replayed it from the start).
- A video with a loop count, opened with `#start=`, plays all its
  passes.

## 1.6.0 (2026-11-14)

Video segments.

- A video item can list `segments`, the camera views one file holds
  (CREATE.md, "Camera views in one video: segments"). After the item's
  last line, Space steps through the views before moving on; Left and
  Right step to the next or previous view without leaving the item, and
  each step shows "View n of m". The Esc screen lists the arrow keys.
- check-game walks segment steps, printing each as a step of its own.
- In WebKit a loop back from a file's end no longer restarts the video
  from 0.

## 1.5.0 (2026-11-14)

check-game for large games.

- check-game's media check runs in parallel after the walk, printing
  progress; `--no-media-check` skips it. It covers every file a shown
  item uses (later animation frames and sound included), and its summary
  says what loaded during the walk, what was checked after it and what
  was never requested.
- A file that fails to load says why: not found, could not decode, not
  readable, or a symbolic link out of the folder.
- `--until ID` walks to that item and reports what the span from the
  start left unshown.
- The validator warns about items that no play-all reading from the
  opening ever shows.
- **Upgrading:** a symbolic link out of the game folder now fails
  check-game on both engines, since the Mac app cannot read through
  one; copy or hard-link those files into the folder instead.

## 1.4.0 (2026-11-14)

Sound.

- Games can have sound, all optional: music that crossfades, ambience
  loops (several at once), one-shot effects, voice lines that hold
  auto-forward until they end, and a video's own soundtrack in step with
  the clip, lowering the music. What plays follows the reader's path,
  through the wheel, jumps and skip too.
- Readers get `v` for sound on or off, and a Volumes box on the Esc
  screen with Music, Effects and Voice sliders, shown only in a game
  with sound. In a browser, sound starts on the first key press.
- kinetic-extract converts a Ren'Py game's sound (`play`, `queue`,
  `stop` and `voice` on every channel, and audible video soundtracks).
  Voice lines no longer become dialogue, and a menu with sound
  statements in a choice block now converts. `kinetic-media ship` takes
  sound files too.
- Each sound file ships with a small script holding its bytes
  (`<file>.js`), so sound plays in a folder opened from disk; looping
  tracks move to a format that loops without a gap. The validator
  checks sound, and `tools/assemble_folder.py` writes a hand-written
  folder's missing scripts.
- `fixtures/audio-demo`, a guided tour of sound, with a listening
  checklist in docs/verify-player.md. Automated test browsers make no
  sound.
- A very large game (around 160,000 items) no longer stops answering
  keys in Chrome.
- **Upgrading:** convert a Ren'Py game again to get its sound. Rebuild
  a game's Windows program (`tools/build_apps.py --windows`) so it can
  play sound from launch; the Mac app needs no rebuild.

## 1.3.1 (2026-11-10)

Game apps, a simpler branch map, large-game checks, poster checks.

- `tools/build_apps.py` adds a Mac app (`--mac`) and a Windows program
  (`--windows`) to a game folder, each playing the game in its own
  fullscreen window; `tools/assemble_folder.py` takes the same flags.
- The Esc screen gains Exit and a Fullscreen | Window switch, in the
  apps and in a browser. Keys held with Cmd, Ctrl or Alt are left to
  the browser or the app.
- The branch map has two views, Full size (scrolls up and down) and Fit
  (the whole map), switched with F. It wraps into bands like a score,
  with route lines spaced evenly.
- Test a built game with no window: `check-game.mjs` and the `openGame`
  library walk it in WebKit or headless Chrome, to the story's end, with
  a coverage summary, `--start-at` and `--until`.
  `index.html#start=<id>` opens a game at an item.
- `kinetic-media posters` checks that each video item's poster is the
  frame at its start, `--fix` ships the right ones, and `--items` limits
  both to listed items; `validate_content.py --ledger` warns about such
  posters.
- Saving progress costs the same however much has been read, so very
  large games stay quick. Also fixed: auto-forward on restored and
  stopped items, Tab and `a` on a choice screen, "Skip on" and "Skip
  off" pills, and images decoded ahead so WebKit skips smoothly.
- **Upgrading:** readers' progress moves to the new save layout on the
  first open. A reader who goes back to an older player of the same
  story, in the same browser, sees fewer items marked seen there;
  nothing is lost.

## 1.3.0 (2026-11-08)

A new look; routes that continue into the join.

- The Transit look: one grey ground with one gold accent, a contained
  Esc screen, and a transit-diagram branch map with larger nodes and
  lines that keep their width at every zoom. Bookmark cards drop their
  caption; hovering shows the time.
- A route's `result` can be `"continue"`: after its last item the story
  flows on into the decision's join, so several alternatives can lead
  into one shared scene without copying it.
- The mouse wheel steps back over unseen screens to the nearest seen
  one, so it no longer dead-ends after a route grows, items are
  inserted or `u` jumps ahead.
- Fixed: after a route is extended, "Return to main route" waits until
  the reader has read the new content.

## 1.2.0 (2026-11-07)

The branch map.

- `m` opens the branch map: every decision and route with the reader's
  marks, endings and a "you are here" marker. Click a reached decision
  or route to go there. Spoilers, off by default, hides the questions
  and route labels of decisions not yet reached.
- Bookmarks sit on the branch map as thumbnails at their place in the
  story: click one to continue there, delete with undo. The `t` screen
  and the `t` and `T` keys are gone.
- Map buttons and the bookmark delete button show their hints at once
  on hover or focus.
- `kinetic-media ship` and `rebuild` encode on parallel workers
  (`--jobs`, `--video-jobs`) with byte-identical output and progress
  lines; a large poster batch ran several times faster.

## 1.1.1 (2026-11-03)

- In Safari, picture bookmarks' thumbnails appear one by one at once,
  instead of all together after a pause, in a game opened from disk.

## 1.1.0 (2026-11-03)

Reproducible media; settings on the Esc screen; a story-order wheel.

- Converted media is reproducible: the same game gives the same bytes
  on any machine, with pinned tools that pass a self-test. Each file is
  named by its content (`media/<h[:2]>/<hash>.<ext>`), stored once, and
  a ledger records how it was made. Images ship as lossless JPEG XL
  when that is smaller and exact; video posters are lossless.
- `kinetic-media ship` converts a list of media without parsing a
  story, for your own converter; `kinetic-media rebuild` verifies or
  reproduces a folder's media from its ledger and the original files.
  `--decoder MODULE:FUNC` hooks in game-specific decoding, a cache makes
  re-runs encode nothing, and several episode projects convert into one
  game.
- Videos follow one measured rule: kept as they are when Safari and
  Chrome both play them, remuxed when only the container fails, and
  re-encoded to H.264 MP4 otherwise.
- Settings live on the Esc screen beside the keys, laid out in a grid
  (`c` is retired). The bookmark list is a grid of large cards that
  opens at once.
- The mouse wheel walks the story in story order, following the route
  picked last at each decision, and `e` goes to the furthest point
  read. Saves migrate by themselves.
- Long choice lists scroll, and the arrow keys and Enter reach every
  route. Fixed: nested routes that share an ending complete the outer
  route too, and the route pill never covers a choice screen.
- **Upgrading:** run `tools/setup_media_tools.py` once before
  converting; the converter refuses to start until it passes. Folders
  converted earlier still play; convert or ship again for the new media
  layout, a ledger and lossless posters (CREATE.md, "Regenerating JPEG
  posters as lossless ones").

## 1.0.0 (2026-11-02)

The first release: a browser player for kinetic visual novels, opened
from a folder on disk with no install, server or network.

- A game is a folder: `index.html`, `app.js`, a `manifest.json` (with
  its `manifest.js`) and the media. Images, animations and videos fill
  the screen; videos take a loop count, a display duration, a playback
  range with its own poster, a loop restart point and a minimum play
  time. Dialogue with speaker names, thoughts and narration show over
  the picture.
- Branches: decisions with routes that continue, return or end, nested
  decisions, and "Return to main route". Play all routes is on by
  default, so every route plays with no interaction.
- Reading: Space, auto-forward (`a`), the mouse wheel back through what
  was seen, Tab to skip seen content, `e` to the end of what was read,
  `u` to the next unseen content, `h` to hide the text, bookmarks with
  thumbnails (`b`, `t`), a settings screen (`c`) and key help (Esc).
- Progress saves in the browser under the manifest's `storyId`, so
  moving the folder keeps it; it can be exported and imported between
  browsers.
- `kinetic-extract` converts a Ren'Py project (`.rpy`, `.rpyc`, `.rpa`),
  making menus into branches where their shape is clear;
  `tools/validate_content.py` checks a folder, and
  `tools/assemble_folder.py` puts the player beside the content.
- Not yet: sound, title or menu screens, windowed play.
