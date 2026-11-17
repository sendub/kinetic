# Future features

Features not yet scheduled. None of them is in docs/progress.md. An entry
marked "requested" is one the user asked for. An entry marked "maybe" is a
candidate the user has not asked for yet but wants kept on record. When
the user schedules one, it becomes a phase in docs/plan.md with its
checklist items, and its entry here goes. A large entry may become several
phases, and the user may take only some of its candidates. Each entry's
"To settle" list holds the decisions to put to the user before the phase
is planned.

## Installable toolchain and Windows authoring (maybe, 2026-11-14)

Today an author clones the repo, makes the venv, installs the converter,
runs `tools/setup_media_tools.py`, runs `npm ci` and `npm run build` in
`player/`, and needs Swift for the Mac app and Go for the Windows program
(AGENTS.md, "Commands"). An author who only writes a story needs none of
the Node toolchain if a release carries the built `index.html` and
`app.js`.

Candidates:

- One `kinetic` command with subcommands for what is now spread across
  `tools/validate_content.py`, `tools/assemble_folder.py`,
  `tools/build_apps.py`, `kinetic-extract`, `kinetic-media` and
  `player/scripts/testing/check-game.mjs`.
- Installed from a release, such as a wheel holding the player bundle,
  instead of from a clone.
- CREATE.md reorganised around that command.
- Windows authors. The pinned ffmpeg in `converter/media-tools.json` has
  builds for macos-arm64, macos-x86_64, linux-x86_64 and linux-arm64
  only, so `kinetic-extract`, `kinetic-media` and every media step refuse
  to run on Windows. Pin a Windows build, whose golden-hash self-test must
  then pass there, or document running the tools under WSL.

To settle:

- The release channel: a wheel on GitHub releases, PyPI, or a clone plus
  one setup script.
- Whether check-game keeps needing Node, or the command starts it.
- A Windows ffmpeg pin, or WSL.
- Whether this comes before "Authoring from scratch", whose new commands
  would join the one command.

## Authoring from scratch (maybe, 2026-11-14)

Today a hand-author writes the runtime format directly (CREATE.md,
"Hand-authoring a content folder"):

- `manifest.json` by hand: unique ids, each branch as `after`, `start`,
  `end` and `continueAt` spans over one flat item list, segment times,
  and audio tracks with decoded `durationSeconds`;
- every image, animation frame and poster cropped to the exact display
  size with ffmpeg, video durations read with ffprobe;
- looping sound re-encoded to a loop-safe format, and each sound file's
  `<file>.js` script written with `base64` and `printf`;
- `manifest.js` written with `printf`, then the validator run.

`kinetic-media ship` already does the media half for converters:
display-size images, posters, durations measured by decoding, loop-safe
audio, the audio scripts, and cached reproducible encodes (CREATE.md,
"Writing your own converter: kinetic-media ship").

Candidates, in a workable order:

1. **A build over a source folder.** The author's manifest names original
   files at any size. The build ships them through kinetic-media, fills in
   posters, durations and audio scripts, writes `manifest.js`, validates
   and assembles. No ffmpeg by hand, and no new format.
2. **A script format compiled to the manifest.** Lines read as
   `Speaker: text`, a media line sets the visual, and indentation under a
   choice holds each route, so the author writes no spans. It needs syntax
   for video ranges, segments, sound and route results. Errors name the
   script line, not a JSON path. A sketch:

   ```text
   # Rainy Day
   story: rainy-day
   size: 1280x720

   [image] art/kitchen.png
   Mei: You're early today.
   Mei (thinks): The street glowed under the awning.
   Neither of us spoke for a while.

   ? How does the afternoon go?
     > To the cafe [ending]
       [image] art/cafe.png
       We took the corner table.
     > Straight home [continue]
       [image] art/street.png
       We walked home under one umbrella.
   ```

3. **Stable ids.** Progress, seen marks and bookmarks are stored by item
   id, so a compiled id must not change when the author inserts a line
   above it. Either the compiler keeps a lock file mapping lines to ids,
   or ids come from a section name plus a hash of the line, with an
   explicit `{#id}` to pin one.
4. **A live preview.** Rebuild on save, reload the page, and open at the
   item being edited through the existing `#start=<id>` (CREATE.md,
   "Playing the folder").
5. **Placeholder art.** A missing image becomes a generated card at
   display size naming the file, so the story plays end to end before the
   art exists. The build lists the placeholders left, and a release build
   refuses them.
6. **A starter.** `kinetic new <folder>` writes a small working project.

To settle:

- Kinetic's own syntax, or an existing one (Ink, a Ren'Py subset, a
  Markdown-like form).
- Whether the script becomes the only source, or a hand-edited manifest
  stays supported beside it.
- The id scheme.
- Where the compiler lives: the converter package or a new one.

## Author checks and helpers (maybe, 2026-11-14)

Today the validator checks a folder and warns on unreachable items
(Phase 48), and check-game walks a folder in a browser and checks every
media file (CREATE.md, "Testing your game").

Candidates:

- **A report per game:**
  - reading time per route, from docs/content-format.md, "Timing";
  - speaker names with their line counts, since a name used once is
    often a typo;
  - files in the folder that no item uses;
  - the longest lines, which may overflow the text box;
  - placeholders left, once "Authoring from scratch" has them.
- **The route graph** as a page or SVG for the author, from the branch
  map's model (`player/src/render/mapmodel.ts`).
- **A video range picker.** A local page plays a clip and marks
  `startSeconds`, `endSeconds`, `loopStartSeconds` and segment times to
  the frame, then prints the manifest fields or script lines. Typing
  fractional seconds is the slowest part of writing a video item.
- **A proofreading export.** Each route as readable HTML or Markdown for
  an editor.

To settle:

- Which of these.
- Command output, or pages opened in a browser.

## Click and touch input (maybe, 2026-11-14)

Today the story advances only from keys and the mouse wheel. Clicks act
on the Esc screen, choice rows, the branch map and the Volumes pop-out. A
click on the story enters fullscreen and starts sound, and nothing else.
Mouse readers expect a click to advance, and a touchscreen laptop or
tablet has no Space, Esc, `m` or `b`.

Candidates:

- A click or tap advances, as Space does.
- An on-screen button opens the Esc screen, with buttons for the map, a
  bookmark, hiding the text and auto-forward.
- A swipe steps back and forward, as the wheel does.

Web hosting is not wanted (below), so phones and tablets may have no way
to open a game folder at all: iOS and Android browsers do not open a
local `index.html` with its scripts (not verified). The gain is then mouse
readers and touchscreen Windows and Mac laptops.

To settle:

- What a click does in auto-forward, in skip and on a choice screen.
- Which part of the screen takes the click.
- Whether on-screen buttons show on a device with no touchscreen.
- Whether touch is in scope at all.

## Signed apps for downloads (maybe, 2026-11-14)

Today `tools/build_apps.py` signs the Mac app ad hoc, for arm64 only
(macOS 12 or later), and leaves the Windows program unsigned. A folder
the author builds opens with no prompt. From a downloaded zip the Mac
app is refused and the Windows program meets SmartScreen (docs/stack.md,
"Distribution decision"), so readers of a download use `index.html`.
Intel Macs cannot run the app.

Candidates:

- Developer ID signing and notarization with the author's own Apple
  identity, as options on `tools/build_apps.py`.
- A universal arm64 and x86_64 Mac binary.
- Authenticode signing of the Windows program with the author's
  certificate.

To settle:

- Whether readers should run the apps from a download at all.
- How the author's identity reaches the build (a keychain profile name,
  never a secret in the repo).
- Testing: agents cannot notarize without the user's Apple account, so
  the user runs that check.

## Text and presentation (maybe, 2026-11-14)

Today the overlay draws every speaker's lines in one style, lines are
plain text, the font is fixed, and a new visual replaces the old one at
once. README.md, "Not supported", lists title and menu screens.

Candidates:

- **A colour per speaker** from an optional top-level `characters` table
  (name to colour, perhaps a display name).
- **Emphasis inside a line** (italic, bold) through a small markup, still
  set as text, never as HTML.
- **The game's own font**, a file in the folder.
- **A crossfade between visuals** that never delays navigation: the new
  visual paints within the 41 ms target and fades in over the old one,
  and skip, the wheel and jumps never fade.
- **Title, credits and content warnings.** These are already possible as
  image and text items at the start or end of the story; document the
  pattern in CREATE.md instead of adding screens.

To settle:

- Which of these.
- A crossfade for the whole game or per item, and its length.
- The markup syntax.
- Which font formats to accept.

## Accessibility (maybe, 2026-11-14)

Today the player follows `prefers-reduced-motion` for its button
transitions only. It has no text size setting, no opaque text box, no
screen-reader announcement of lines (no `aria-live` region), and Phase
47's sound has no captions. Spoken lines are docs/plan.md Phase 52.

Candidates:

- A text size setting.
- An opaque or darker text box for busy art.
- A reduced-motion setting that holds animations on their first frame
  and videos on their poster.
- Each line announced to screen readers.
- Captions for sound effects, such as a `caption` on a track.

To settle:

- Which of these.
- Where the settings sit; Phase 47 rebalanced the Esc screen for the
  Volumes pop-out.
- Whether reduced motion changes the timing rules in
  docs/content-format.md, "Timing".

## Per-language pictures (maybe, 2026-11-16)

Phase 56 keeps pictures the same in every language. Words drawn into a
picture (a phone screen, a sign, a title card) stay in the original
language; an author can put them in a text item instead. Ren'Py can
replace a file per language (`game/tl/<language>/`), but no game in the
corpus does.

Candidates:

- A language file swapping an `image` item's file, or an animation's
  frames, for its own.
- Video swaps, much heavier and rarer.

To settle:

- Whether a real game needs it.
- How `kinetic-media ship`, the media ledger, `rebuild`, poster checks
  and preloading handle files per language.

## Ren'Py auto-voice files (maybe, 2026-11-17)

Ren'Py's `config.auto_voice` plays `voice/<identifier>.ogg` for a line,
named by the line's translation identifier. Phase 56's converter now
computes those identifiers (on a converted corpus game 3,978 of its
lines matched such files), so kinetic-extract could ship them as the
items' recorded voice lines.

To settle:

- Whether to ship them by default, and how the author confirms the
  pattern.
- Per-language voice folders, if a game has them.

## Not wanted

- Web hosting, such as itch.io (the user, 2026-11-14). A game stays a
  folder opened from disk or through its app.
- Fonts shipped with a game, for its base language or a translation
  (the user, 2026-11-16: game developers choose badly; a good, readable
  system font is wanted). The player picks system fonts by writing
  system.
