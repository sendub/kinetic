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

## 1.15.0-dev

- A reload, or closing and reopening the game, with a choice open
  shows the choice again, waiting for an answer (with Play all routes
  on, its countdown starts again). Before, no choice showed, and with
  Play all routes off the reader was stuck until a wheel notch back and
  forward.
- Reading on at a branch plays the animation or video there as the
  first reading did, over content already read too: from a route's end
  onto where the routes join, past a decision that passes on, and into
  a route picked on the choice screen, by Play all routes or by a
  following decision. Before, back before the branch and reading on
  again showed it as a still (an animation's first frame, a video's
  poster) and played nothing. A jump from the branch map still shows a
  still.
- A decision that follows an earlier one: a decision's optional
  `follows` names an earlier decision, and each of its routes may give
  `when`, the routes of that decision it belongs to (at most one route
  without `when` takes the rest). With Play all routes off it shows no
  choice: the route matching the reader's last pick there starts at
  once, its route pill shown, or, when no route takes that pick, the
  story goes on at `continueAt`; with no pick known it is an ordinary
  choice. With Play all routes on it is an ordinary decision whose
  matching route plays last. The wheel follows the matching route
  through it, and `kinetic routes` and `kinetic export` say what it
  follows and which pick each route takes. The validator checks both
  fields (docs/content-format.md, "Branches", rules 26 and 27). An
  older player ignores them and shows an ordinary choice.
- Shared spans in the format: a decision's optional `shared` lists
  spans of items laid out once, each with an `id`, `start`, `end` and
  a `result` as a route's, and a route's optional `then` names one of
  them, of its own decision or of one enclosing it, to read after the
  route's end, the span's `result` then acting in place of the
  route's. The validator checks both (docs/content-format.md,
  "Branches", rules 28 to 30). An older player ignores them: a route
  with `then` acts on its own `result`.
- The player reads shared spans: after the end of a route with `then`
  the story reads on into its span with no choice screen, the reader
  still in the route they picked (no new route pill; the route counts
  as finished when the span is), and at the span's end its `result`
  acts as that of a route of the span's decision would. With Play all
  routes on, a span an earlier route of the same pass read already is
  skipped through on its own, as Tab skips, under the pill "Read
  already: skipping" (Space stops it); with it off a span is read every
  time. The wheel walks a span after the route last picked that reaches
  it, and a bookmark, save or reload inside a span keeps the route
  that led in. The validator's never-shown warnings follow spans, and a
  pure choice's region runs to its last route or span end.
- The branch map draws a shared span once, as a box with rounded
  corners after its decision's routes, with a line into it from each
  route that goes on to it (a route of a nested decision too), and
  shows where the span leads as a route's: back to the story, back to
  the choice, or an ending. The box fills in as a route pill does, "you
  are here" follows the reader through the span, and a click on the box
  plays the span from its start as one of the routes going on to it.
  `kinetic routes` lists each decision's shared spans after its routes,
  with the routes reaching each, and a route with `then` names its span
  (`--dot` draws the span as a box, `--json` carries `shared`, `then`
  and `thenDecision`); `kinetic export` prints a span once, after its
  routes, under a heading naming the routes that reach it (`--out`
  writes it a file of its own); `kinetic report` counts a span's items
  once in the story's reading time, adds a span to each route with
  `then` and lists the spans, and its shortest reading goes through
  them. A pure choice's line on the map and in these tools now carries
  on past its spans, where it went into them.
- The converter makes a decision of a menu whose choices set variables
  and `jump` (or `call`, or `return`) elsewhere, the commonest Ren'Py
  menu, where it used to keep it linear (`jump inside a choice block`).
  Each choice's path to where the paths meet is its route: one reaching
  that join is `"continue"`, the last such route the `continuingRoute`
  and the join its `continueAt`; one jumping back to the menu, or to the
  question just before it (a refusal), `"return"`; one reaching the
  story's end `"ending"`. A menu whose choices hold their lines in place
  now continues at its join too, where 1.14.0 wrote a pure choice whose
  routes all ended, which made a reader with Play all routes off read
  every route before going on. A choice with no line of its own, and a route
  that opens with a nested menu, shows its choice text as a line,
  translated from the language's `strings` block. Menus inside routes
  become nested decisions. A menu stays linear, reported, when every
  choice is empty, when a choice's path rejoins another's content away
  from the join, or when a choice is conditional (`"x" if cond:`). The
  ledger's `branchDetection` note says how each route's result was
  proven (docs/extracting.md, "The walk follows labels").
- A menu of one plain choice keeps the choice, often the protagonist's
  line, as a narration line where the menu stood, translated from the
  language's `strings` block, and reads on with its block, where the
  converter dropped it (`fewer than two choices`).
- The converter makes a decision of an `if`/`elif`/`else` chain whose
  tests read one variable the script sets (`$ x = ...`, `+=`, `-=`,
  `default`, `define`), where it used to skip every arm as an
  `unrecognized statement` and drop their lines and sound. The arms
  become routes that go on where they meet. A variable only one menu's
  choices set gives a decision that `follows` that menu, its routes
  labelled `If you chose: Wake Robin`, also when label flow gives it a
  starting value before the menu (`$ pick = ""`) that nothing sets
  again after it; a counter gives an ordinary
  decision labelled by ranges (`love 3 or more`, `love 1 or 2`, `love
  under 1`); any other test one labelled by the choices that set it or
  in words (`met is set`); the prompt is `Which fits your story so
  far?`. The words come from the player's catalogue, in the game's base
  language and each language file's own (English where the catalogue
  lacks a language). `kinetic extract --condition-names FILE` names the
  variables in the labels, for every language or per language. An arm
  no value takes is left out, reported. A chain on two variables, a
  function call, Ren'Py's or persistent state stays as before, reported
  `if chain not converted (why)`. The ledger's `conditions` and a new
  `kinetic report` section list each such decision with the languages
  whose words fell back to English (docs/extracting.md, "Conditions").
- Animation timing: two new optional fields on an `animation` item.
  `frameSeconds`, one display time in seconds per frame, times the
  frames unevenly in place of `fps`, and one loop lasts their sum;
  `holdLastFrame: true` stops on the last frame after `loopCount` loops,
  under the lines after the animation too, instead of looping on, and
  rewinding, skipping or jumping onto those lines shows that last frame
  (docs/content-format.md, "Items" and "Text items"). `fps` stays
  required: an older player ignores both fields and plays the frames
  evenly at `fps`, looping under the lines as before. The validator
  checks that `frameSeconds` has one entry per frame, each above 0, and
  `kinetic report`'s reading time counts the loops by `frameSeconds`.
- The converter turns an `image name:` ATL frame list (quoted frames,
  `pause N` between them, perhaps a last `repeat` or `repeat N`) into an
  `animation` item that `show name` shows, where it used to report
  `image without a file` and drop every line said over it. Even pauses
  set `fps`, uneven ones `frameSeconds`; a bare `repeat` loops, `repeat
  N` plays N loops and holds the last frame, no `repeat` plays once and
  holds. The frames ship as images, a shared one once, and `kinetic
  media rebuild` checks them. A frame's `with` plays as a cut and a
  `function` is dropped, both reported; a one-frame block is that
  picture as a still, its transform properties reported as not applied;
  a block with other ATL stays `image without a file`, the report naming
  the statement (docs/extracting.md, "ATL frame lists").
- The converter makes a decision of a menu whose route shows an
  animation or plays a video, where it used to keep it linear (`choice
  N contains a animation item`). A route after the first whose first
  line is said over the picture, animation or video on screen at the
  menu now shows that visual, where the player showed whatever the
  route before it last showed: the line's item repeats the menu's
  visual (docs/extracting.md, "The walk follows labels").
- The converter reads script and `tl/` lines indented with
  non-breaking spaces (U+00A0) as Ren'Py does, where a translation block
  indented that way gave no text, and breaks lines only where Ren'Py
  does, so a form feed, U+2028 or another such character inside a line
  no longer splits it and shifts the line numbers that sources and
  translation identifiers come from.
- The converter lays out once a scene that two or more choices of one
  menu go on to before the paths meet (a failure scene two choices
  jump to, say), where it used to keep the menu linear (`choice N
  rejoins content read at ...`): the scene becomes a shared span of the
  decision after its routes, each route reaching it names it in `then`,
  and the span goes on where the scene does: back to the story at the
  join, to the story's end, or back to the choice. A nested menu whose
  choices meet at the scene joins at it, the route holding that menu
  going on to it. A scene a nested menu's route reaches while its
  sibling routes go elsewhere, and one holding a menu of its own, still
  keep the menu linear, reported as before. The validator's never-shown
  warning for an item in a shared span no route reaches says so
  (docs/extracting.md, "The walk follows labels").
- **Upgrading:** a folder you keep as converted needs nothing; its
  player reads `follows`, `frameSeconds` and `holdLastFrame` once
  upgraded. Converting a Ren'Py game again with this release gains its
  jump menus, conditions, one-choice lines and frame-by-frame
  animations, with the lines and sound that went with them, and its
  converted menus continue at their joins instead of being pure
  choices: more items come out, items after the first change get new
  ids, and a reader's saved place, seen items and bookmarks follow item
  ids, so check them before shipping the game again under the same
  `storyId`. Read `kinetic report`'s "Decisions made from conditions",
  name the variables there in a `--condition-names` file kept with the
  game, and pass it on every conversion.

## 1.14.0 (2026-11-21)

- `kinetic upgrade <folder> --to NEW --link-media` hard-links every
  file under the folder's `media/`, named or not, for a game that keeps
  every media file it has shipped. `--to`, real or dry run, now prints
  how many files it hard-links and copies and their sizes, and without
  `--link-media` a second line counts the files under `media/` that
  nothing names and that are copied. A hard link that fails still stops
  the copy and leaves no NEW (CREATE.md, "Upgrading to a newer
  Kinetic").

## 1.13.0 (2026-11-20)

- How a reader gets the player's own words in another language:
  docs/player.md ("Languages") and CREATE.md ("Translating a game") say
  where, for the Mac app (System Settings, General, Language & Region,
  for the whole Mac or the game's app alone), the Windows app (the
  display language) and a browser (its language). By design no manifest
  setting pins them to the game's language. A check script that reads
  the player's words passes `language` to `openGame` (`--lang` to
  `kinetic check`), so it passes on a machine in any language.
- Every `kinetic` subcommand's `--help` describes it in a whole
  sentence, true for an installed Kinetic and a checkout alike.
- `kinetic upgrade --dry-run` says what an upgrade would replace and
  validates the folder as it is, writing nothing. `kinetic upgrade
  <folder> --to NEW` upgrades a copy made at NEW and only reads the
  folder: its media are hard-linked, so the copy takes almost no space,
  and everything else is copied, the apps with their signatures intact.
  Check the copy, then upgrade the delivered folder with the same
  release, which writes the same player files (CREATE.md, "Upgrading to
  a newer Kinetic").
- The testing library comes in the wheel: `kinetic check --library`
  prints the path a test script imports, with no npm, clone or
  `node_modules` (CREATE.md, "A test script"). `openGame`'s `savedState`
  opens the game as for a reader who saved that state record, and the
  handle's `storageKey` and `savedState()` read the key and the record
  back.
- `kinetic release-status [--json]` prints the installed Kinetic's
  version, the commit it was built from, how many items of its
  release's checklist are checked and open, and its CHANGELOG entry,
  with no network. The wheel carries that checklist (docs/progress.md)
  and CHANGELOG.md.

## 1.12.0 (2026-11-17)

- Kinetic installs without a checkout: each GitHub release carries a
  wheel, so `pip install
  https://github.com/sendub/kinetic/releases/download/vX.Y.Z/kinetic-X.Y.Z-py3-none-any.whl`
  into a venv of its own, then `kinetic setup` once, gives every tool
  as one command, `kinetic`: `setup`, `extract`, `media` (`ship`,
  `rebuild`, `posters`), `validate`, `assemble`, `apps`, `upgrade`,
  `check`, `report`, `routes` and `export`. It needs Python 3.12 or
  later; `kinetic check` also needs Node.js 22.12 or later (and Chrome
  for its `chrome` engine), and the Mac app needs macOS. No Swift, Go,
  npm or clone. An installed Kinetic keeps its media tools and caches in
  folders of the user's own (`~/Library/Application Support/Kinetic`
  and `~/Library/Caches/Kinetic` on macOS), or under `KINETIC_HOME`.
  The old names, `kinetic-extract`, `kinetic-media` and the `tools/`
  scripts in a checkout, still work with the same arguments. CREATE.md
  starts with "Installing Kinetic".
- The game apps are made from host programs each release builds once,
  so `kinetic apps` (and `kinetic assemble --mac --windows`) needs no
  Swift or Go: the Windows program is made on any system, the Mac app
  on any Mac, which signs it ad hoc. Each app reads its game's title,
  story id and first window size as it starts. `--self-check FILE` on
  either app writes those settings to FILE and exits, with no window.
- Speaker colours: a new optional manifest field, `characters`, gives a
  speaker a colour for the name (`nameColor`), for the lines
  (`textColor`), or both (docs/content-format.md, "Characters"). A
  coloured thought stays italic and is drawn dimmer, and a translated
  name keeps its colours. The validator warns about an entry no speaker
  uses and a colour hard to read against the text band. Older players
  ignore the field.
- Text tags: the player reads Ren'Py's tags in lines, choice questions
  and route labels, in every language. `{i}`, `{b}`, `{u}` and `{s}`
  draw italic, bold, underlined and struck-through text, `{p}` starts a
  new line, `{{` is a brace, the tags that only time Ren'Py's typing
  (`{w}`, `{nw}`, `{fast}`, `{cps}`) are left out, and the others keep
  their text (docs/content-format.md, "Text tags"). Reading time counts
  what is shown, not the tags. Converted games already hold the tags,
  which older players showed as written. The validator warns about an
  unknown or unclosed tag.
- Transitions: a picture item may set `transition`, a `dissolve` over
  the picture before or a `fade` through black (docs/content-format.md,
  "Transitions"). A transition never holds up the reader: the line shows
  at once, a key ends it, and skip, the wheel, jumps, a reload and a
  reduced-motion setting cut. Older players cut.
- Spoken lines say the line as shown, its tags read, live and in
  `tools/record_lines.py` alike.
- `kinetic extract` keeps a Ren'Py game's presentation: a Character's
  literal colours become `characters`, and `with dissolve`, `with
  fade`, `Dissolve(t)`, `Fade(out, hold, in)` and names defined as those
  become transitions. Other transitions cut, and the summary counts
  them by name (docs/extracting.md, "Colours and transitions").
- `kinetic extract` reads the story as Ren'Py runs it: from `label
  start` through `jump`, `call` and the fall into the next label of a
  file, each statement once, with computed jumps (`jump expression` and
  the like) walked to the labels the game's code names, each where its
  name is written. Labels the story never reaches, such as a developer
  script or a minigame, are reported, not converted; `--also-label
  NAME` and `--include-unreached` bring them in after the story. Before,
  the scripts were joined in file-name order, so such lines became
  items and a game whose files were not in story order read out of
  order (docs/extracting.md, "The walk follows labels").
- More `kinetic extract` fixes: scripts in subfolders of `game/` are
  read, as Ren'Py loads them; characters made in `init:` blocks, `$`
  lines and `init python` get their names and colours, and a nameless
  one takes its `kind`'s name; a file under `images/` named by its bare
  file name, or by the lowercased name Ren'Py gives it, is found, as
  Ren'Py finds it; `show screen` is no longer read as a picture; a
  `define` with an init priority is read; an `image x:` animation block
  no longer gives text items.
- `kinetic report` prints what someone who cannot watch the game wants
  to compare with the original: reading time per route, speakers with
  their line counts and look-alike names flagged, colours and
  transitions, text tag problems, files nothing uses and the longest
  lines. `kinetic routes` prints the decisions and routes as an outline
  (or Graphviz DOT), and `kinetic export` the story as Markdown, a file
  per route, to lay beside the Ren'Py script. Report and routes print
  plain text, or JSON with `--json` (CREATE.md, "Checking a conversion:
  kinetic report").
- check-game (`kinetic check`) opens a game at its own size, scaled into
  480 x 270 to 1920 x 1200, in place of 1280 x 720, and warns about each
  line that runs off the screen or out of its column, with a summary
  line; the exit status is unchanged.
- The validator, report, routes and export stay fast on games with
  thousands of decisions (20,000 decisions: the validator's branch
  checks from 35 s to under a second), and stop with a message on
  malformed branches instead of running on.
- Media tools: converting now works on 64-bit Windows and 64-bit Linux
  on Intel or AMD as well as on Apple silicon Macs; Linux on Arm is not
  pinned yet, and setup there says so. Intel Macs are dropped from the
  pins (the Mac app is arm64 only). A few recipes give other bytes on
  an Intel or AMD processor than on Apple silicon, so a folder's ledger
  records the platform that made it and `kinetic media rebuild`
  verifies it there; elsewhere it stops with `made on <platform>;
  rebuild there to verify` (exit 3). Files the tools write have LF line
  ends on every system.
- The validator suits a gate: a clean folder prints nothing at all,
  translations included, since the per-language coverage lines (and
  `0 poster warnings` with `--ledger`) are gone from its output.
  `--strict` makes warnings of any kind exit 3 when there are no
  problems (0 clean, 1 problems, 2 bad arguments, as before), and
  `--json` prints problems, warnings grouped by kind, each language's
  coverage and the exit status as one JSON object. `kinetic report`
  gains a translation coverage section, counted by the validator's own
  code (CREATE.md, "Validating").
- **Upgrading:** a checkout's venv that has Kinetic installed under its
  old name needs `.venv/bin/pip uninstall kinetic-extract` before
  `.venv/bin/pip install -e ./converter --cache .tmp/pip-cache`. From
  now on a release can be installed from its wheel instead (CREATE.md,
  "Installing Kinetic").
- **Upgrading:** a folder converted before this release shows its text
  tags as emphasis once its player is upgraded, but gains speaker
  colours and transitions only by converting it again. Converting
  again also follows the story from `label start`: lines in labels the
  story never reaches drop out, the items may come in another order,
  and items after the first change get new ids. A reader's saved place,
  seen items and bookmarks follow item ids, and the manifest's `voices`
  follow speaker names, so check both before shipping a converted game
  again under the same `storyId`, and read the summary's `walk:` lines
  for anything that should come back with `--also-label`.
- **Upgrading:** a folder converted before this release names no
  platform in its ledger and counts as made on an Apple silicon Mac:
  rebuild it there, since elsewhere `kinetic media rebuild` exits 3. A
  script that reads rebuild's exit status meets that new code. The
  reuse cache now keys on the platform, so the first conversion after
  upgrading encodes everything once more.
- **Upgrading:** the validator no longer prints a coverage line per
  language: read coverage from `kinetic report` or `kinetic validate
  --json`. A gate can rely on silence and exit 0 when a folder is clean,
  and add `--strict` to fail on warnings too (exit 3); a script that
  matched the coverage lines or `0 poster warnings` on stderr needs
  changing.
- **Upgrading:** check-game now walks a game at its own size, so a line
  that fitted at 1280 x 720 may be reported as overflowing at a smaller
  game size; a test that reads check-game's output also meets the new
  `line overflow at W x H` summary line. Apps already in a folder keep
  working as they were made.

## 1.11.0 (2026-11-17)

- Translations: a game can be read in several languages from one
  folder. The manifest keeps the game's own text, and each translation
  is a language file, `lang/<tag>.json` with its script `lang/<tag>.js`,
  named in two new optional manifest fields: `language`, the game's own
  (default `en`), and `languages` (docs/content-format.md,
  "Translations"). A language file translates the lines, speaker names,
  choice questions and route labels, the title and the version, each
  recording which original it was made from; pictures, timing, sound
  and branches stay the same in every language. Older players ignore
  both fields and play the game's own language. The validator checks
  the files and warns about each missing translation, each stale one
  (its original changed since) and each much longer than its original,
  with a coverage line per language.
- The Language control: in a game with more than one language, the Esc
  screen's title bar shows a globe and the current language in its own
  name, at the right of "Esc or Space closes"; a click opens the list
  over the screen, so nothing moves. Switching draws the screen on show
  again in the new language and keeps the place, picks, seen items,
  bookmarks and auto-forward. A game opens in the reader's system
  language when it has it (`de-AT` takes `de`, `zh-TW` takes `zh-Hant`),
  otherwise in its own; once the reader picks one, the pick is kept for
  that game. A line with no translation shows the original. Auto-forward
  gives each language its own reading time, so Chinese, Japanese and
  Korean lines, which say more per character, are not rushed.
- The player's own words (the Esc screen and its notes, help, pills,
  confirmation boxes, choice hints, the end card, the branch map, the
  Volumes sheet) come in 39 languages, following the reader's system
  language when Kinetic has it, and English otherwise; the Language
  control changes the story only, never them. The Mac app's menus, both
  apps' messages before the game loads, and the voice download's
  messages follow too; the window title follows the story's language. The 38 languages besides English are unreviewed drafts;
  corrections are welcome (docs/verify-player.md, "The player's words").
- A reader can give a game's Mac app a language of its own in System
  Settings (Language & Region, Applications): the app declares the 39
  languages of the player's words, so macOS no longer says it "doesn't
  support additional languages". The game, the player's words and the
  menus then start in that language, and the controls stay in it after
  a pick of another language for the story.
- Right to left: under an Arabic, Persian, Hebrew or Urdu system
  language the text, choices, Esc screen, help, Volumes sheet, end card
  and pills mirror, and sliders run from the right; a story picked in
  one of them reads right to left in its own lines. The branch map keeps its layout, and the
  arrow keys keep their direction.
- Every language is drawn in the reader's system fonts, a readable face
  per writing system, so Chinese, Japanese and Korean each get their own
  forms of shared characters. In scripts whose fonts have no italic
  (Chinese, Japanese, Korean, Arabic, Persian, Urdu, Hebrew, Thai and
  the Indian scripts), thoughts are drawn upright, set apart by colour
  alone, and so are the end card's hint and the resume notice.
- Spoken lines follow the language shown. A language file may carry its
  own recorded lines (`voice`); without one, the apps speak a line live
  in the language shown, and a language the voice engine does not speak
  stays silent. `keepOriginalVoice` plays the original recordings under
  a translation, like subtitles; without it they stay silent there. The
  Sound row, Volumes..., `v` and the Volumes sheet's rows follow the
  language shown, changing on a switch. `tools/record_lines.py --lang
  TAG` records a language's lines into its language file, and without
  `--lang` it now speaks the manifest's `language` rather than always
  English, refusing one the engine lacks.
- `tools/translations.py` hands a game's text to translators as PO
  files, the format Poedit, Weblate and Crowdin read: `export` writes a
  language's strings with context for each line (merging what the game
  already has, and marking for review a translation whose original has
  changed), `import` writes the language file from the translated file,
  and `status` shows each language's coverage (docs/translating.md;
  CREATE.md, "Translating a game").
- `kinetic-extract` reads a Ren'Py game's own translations (`game/tl/`,
  loose or inside its `.rpa` archives): each language becomes a language
  file, its lines matched to the story by Ren'Py's translation
  identifiers and its menu choices, captions and character names taken
  from its `strings` blocks; a translation whose English changed since
  is kept, marked stale; a game with recorded voice lines gets
  `keepOriginalVoice`, as Ren'Py plays the original voices. The summary
  reports what matched and the coverage. `--language-map NAME=TAG` names
  a language the converter does not know, `--base-language TAG` names a
  game's own language when it is not English (its `tl/english` then
  becomes an English language file), and `--no-translations` leaves
  them out (docs/extracting.md, "Translations").
- `kinetic-extract` fixes: an `extend` line joins the line before it,
  in one item with that line's speaker, as Ren'Py shows it (before, it
  became an item of its own spoken by "extend"); a character named with
  `_()`, `name=` or a dynamic name gets its display name; an archive
  holding both `x.rpy` and `x.rpyc` has the story read once, from the
  `.rpy`, as for loose files (before, it was read twice, doubling every
  item); a loose script in a subfolder of `game/`, which the walk does
  not read, no longer hides the archived script it shadows; archived
  scripts follow `--files` as loose ones do, and a loose `.rpyc` is no
  longer also read as script text; looking up a game's archived
  pictures and sounds is much faster (one large game's walk went from
  over 5 minutes to under 40 seconds).
- **Upgrading:** a folder you keep as converted needs nothing. Converting
  a Ren'Py game again with this release may give a different folder:
  the converter numbers items in story order, so in a game with `extend`
  lines or with archived `.rpy` and `.rpyc` pairs, fewer items come out
  and the items after the first change get new ids, and a speaker
  defined with `_()` gets its display name in place of what it had. A
  reader's saved place, seen items and bookmarks follow item ids, and
  the manifest's `voices` follow speaker names, so check both before
  shipping a converted game again under the same `storyId`.
- `check-game.mjs --lang TAG` walks a game with that language shown and
  reports the lines it met that showed the original (no translation)
  or were stale; `openGame`'s `language` option does the same in a test
  script (CREATE.md, "Testing your game").
- `tools/assemble_folder.py` carries `lang/` into the folder readers
  get, writing a missing `lang/<tag>.js`, and ships a language's
  recorded lines as their scripts, leaving the audio files out as for
  every track; `tools/upgrade_folder.py` leaves `lang/` as it is and
  refreshes `lang.schema.json`, the language files' schema copy for an
  author's editor, which assembly leaves out (docs/packaging.md).
- The route pill on an ending no longer covers the end card: it sits
  just below it at every window size.

## 1.10.1 (2026-11-17)

- Tests on the `webkit` engine (check-game, `openGame`) no longer lose
  clicks and drags when the computer's own mouse button is down while
  they run: the WebKit helper now reports only its own simulated
  button to the page.

## 1.10.0 (2026-11-17)

- A test-only trace of every screen the player shows: with
  `window.KINETIC_TEST_TRACE` set before it starts, the player records
  each item, choice screen and end card, skipped items included, in
  `window.__kineticTrace` and as `kinetic:item` events.
- The testing library reads that trace: `openGame(folder, { trace: true
  })` turns it on, and the game's `trace()` returns the records since
  the last call, so a test can check every item a skip or a Play all run
  passed. It refuses a folder whose player is too old to keep a trace,
  saying so.
- check-game's `--trace FILE` writes every record of its walk to FILE,
  one JSON object per line, and its summary says how many it wrote.

## 1.9.1 (2026-11-16)

- CREATE.md, README.md and docs/packaging.md no longer describe spoken
  lines on Windows as still to come: the Windows program has them since
  1.9.0, on a PC with an NVIDIA card.

## 1.9.0 (2026-11-16)

- Spoken lines: a game can give its characters voices, and the reader's
  computer speaks each line in its speaker's voice, generated while they
  read, in the Mac app and the Windows program. A reader opts in with
  **Download voice model** in the Voice row of the Esc screen's
  Volumes... sheet, a one-time download shared by every Kinetic game on
  the computer: about 3.3 GB on a Mac (Apple silicon, macOS 14 or
  later), 6.8 GB on Windows. The row's ? explains it, and once the model
  is in, the row holds the Voice slider with a small **remove voice
  model** button. Voice volume 0 asks for no lines. Lines are made at
  about half their length, the next ones ahead of the reader, and kept
  so a reread is instant. Auto-forward waits for a line still being
  made, up to 20 seconds. Thoughts are spoken in their speaker's voice,
  lines with no speaker in a narrator voice, and a recorded voice line
  always plays instead. A browser plays such a game silently. On
  Windows, spoken lines need an NVIDIA graphics card (driver 570.65 or
  later); on any other PC the download button is greyed out and its ?
  says why.
- The Volumes... sheet shows a slider only for the sound a game has
  (music, effects, voice), and a game with no sound at all has no
  Volumes... button. Dragging a slider out of the sheet and letting go
  no longer closes it.
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
- `tools/record_lines.py` records every line that would be spoken live,
  with the same engine the apps use, as mono Opus in WebM (16 kb/s by
  default) and writes them into the game as recorded voice lines, so a
  reader needs no 3 GB voice download: about 0.8 GB for a 75-hour game.
  It resumes after an interruption, and a rerun after edits records only
  the lines that changed and removes the recordings no item uses.
  CREATE.md has "Recording the lines".
- In a game app (the Mac app, the Windows program) no text on the Esc
  screen names a browser any more: Progress's help reads "Saved as you
  read. Export and Import carry it to another device.", and the Import
  button, its confirmation box and its failure notice speak of the
  progress saved here. The browser tab keeps its words.
- **Upgrading:** nothing is needed for a game without voices. To give a
  game voices, upgrade its player (`tools/upgrade_folder.py`), cast the
  voices, and either build the Mac and Windows apps again or record the
  lines with `tools/record_lines.py`.

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
