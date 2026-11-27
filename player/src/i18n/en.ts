// The player's words in English: the source of truth for every language
// (./catalogue.ts). Each key is stable and dotted by where it shows; each
// entry's doc comment tells a translator where and how it is used and goes
// into player/locales/messages.pot as its `#.` comment (scripts/i18n.mjs
// requires one). `{name}` is a placeholder a translation keeps as written
// (a key cap, a number, a game's own text); a plural message is an object
// keyed by CLDR plural category, picked by its `{count}`. Key caps (Space,
// Esc, Tab, Enter, letters, digits) stay as keyboards print them, so a
// sentence naming one takes it as a placeholder.

import type { Message } from "./catalogue.ts";

export const EN = {
  /** Browser tab title when the game names itself nothing (the player's name). */
  "page.title": "Kinetic",
  /** Shown in place of the game when its files cannot be read; {detail} is a technical reason, in English. */
  "error.load": "Could not load the content: {detail}",

  /** Esc screen: the heading over the grid of keys. */
  "help.title": "Keys",
  /** Esc screen, title bar: the keys that close the screen. */
  "help.hint": "{esc} or {space} closes",
  /** Esc screen, title bar: accessible name of the Language control, a button opening the list of the game's languages; {language} is the language shown now, named in itself (e.g. Deutsch). */
  "lang.control": "Language: {language}",
  /** Esc screen: accessible name of the open list of the game's languages (each named in itself). */
  "lang.list": "Language",
  /** Pill when a language of the game cannot be read: the game stays in the language it was in. {language} is that language named in itself (e.g. Deutsch). */
  "lang.unavailable": "{language} could not be loaded",
  /** Esc screen, bottom corner: the player's name and release ({version}, e.g. 1.10.0). */
  "help.kinetic": "Kinetic {version}",
  /** Esc screen, key grid: the cap drawn for the mouse wheel (one cap, short). */
  "keys.wheel.cap": "wheel",
  /** Esc screen, key grid: what Space does (lower case, short). */
  "keys.advance": "next item; stops auto-forward",
  /** Esc screen, key grid: what the Left and Right arrows do. */
  "keys.segments": "previous / next view of a video",
  /** Esc screen, key grid: what the mouse wheel does. */
  "keys.wheel": "back / forward through the story",
  /** Esc screen, key grid: what E does. */
  "keys.end": "jump to the furthest point read",
  /** Esc screen, key grid: what U does. */
  "keys.unseen": "next unseen content",
  /** Esc screen, key grid: what Tab does. */
  "keys.skip": "skip what you have seen",
  /** Esc screen, key grid: what A does. */
  "keys.autoForward": "auto-forward on / off",
  /** Esc screen, key grid: what H does. */
  "keys.text": "hide / show the text",
  /** Esc screen, key grid: what V does (games with sound). */
  "keys.sound": "sound on / off",
  /** Esc screen, key grid: what B does. */
  "keys.bookmark": "bookmark this moment",
  /** Esc screen, key grid: what M does (a click on the row opens the map too). */
  "keys.map": "branch map and bookmarks",
  /** Esc screen, key grid: what Esc does. */
  "keys.escape": "this screen: keys and settings; closes the map",
  /** Esc screen, key grid: the keys at a decision (1-9, 0, arrows, Enter). */
  "keys.decision": "at a decision: pick a route; 0 returns to main route",

  /** Esc screen: the heading over the settings. */
  "config.title": "Settings",
  /** Settings: the reading speed row's label (it paces auto-forward). */
  "config.speed.label": "Auto-forward speed",
  /** Settings: accessible name of the "?" after the speed label. */
  "config.speed.about": "About auto-forward speed",
  /** Settings: the tip behind the speed's "?". */
  "config.speed.tip": "Also times play-all's choice countdown.",
  /** Settings: accessible name of the speed's minus button. */
  "config.speed.decrease": "Decrease auto-forward speed",
  /** Settings: accessible name of the speed's plus button. */
  "config.speed.increase": "Increase auto-forward speed",
  /** Settings: the speed readout, small; {speed} is the multiplier (1.00), {ms} the milliseconds per character. */
  "config.speed.readout": "{speed}x (~{ms} ms/char)",
  /** Settings: the heading over the two options of how Tab skips ({tab} is the key). */
  "config.skip.section": "When {tab} skips",
  /** Settings: option under "When Tab skips": skipping also passes content never seen. */
  "config.skip.all": "Skip unseen content too",
  /** Settings: option under "When Tab skips": a skip plays each video in full. */
  "config.skip.videos": "Play videos in full",
  /** Settings: a switch's state, on (short). */
  "config.on": "On",
  /** Settings: a switch's state, off (short). */
  "config.off": "Off",
  /** Settings: the switch that makes every decision pick itself in turn. */
  "config.playAll": "Play all routes",
  /** Settings: accessible name of the "?" after "Play all routes". */
  "config.playAll.about": "About play all routes",
  /** Settings: the tip behind "Play all routes"' "?". */
  "config.playAll.tip": "When on, choices pick themselves on a countdown.",
  /** Settings: the Sound row's label (games with sound). */
  "config.sound": "Sound",
  /** Settings: the button that opens the Volumes sheet. */
  "config.sound.volumes": "Volumes…",
  /** Settings: accessible name of the Volumes… button. */
  "config.sound.volumesAria": "Sound volumes",
  /** Settings: the heading over Export, Import and Reset. */
  "config.progress.section": "Progress",
  /** Settings: after the Progress heading, dimmer: saving needs no action. */
  "config.progress.saved": "saved automatically",
  /** Settings: accessible name of the "?" after the Progress heading. */
  "config.progress.about": "About progress",
  /** Settings: the Export row's label. */
  "config.export.label": "Export progress",
  /** Settings: the Export row's button (short). */
  "config.export.button": "Export",
  /** Settings: accessible name of the Export button. */
  "config.export.aria": "Export this story's progress to a file",
  /** Notice pill after an export (the file's name is not said). */
  "config.export.done": "Progress exported",
  /** Settings: the Import row's label. */
  "config.import.label": "Import progress",
  /** Settings: the Import row's button, which opens a file picker (short). */
  "config.import.button": "Import…",
  /** Notice pill: the picked file could not be read at all. */
  "config.import.unreadable": "That file could not be read.",
  /** Settings: the Reset row's label. */
  "config.reset.label": "Reset progress",
  /** Settings: the Reset row's button, which opens a confirmation (short). */
  "config.reset.button": "Reset…",
  /** Settings: accessible name of the Reset button. */
  "config.reset.aria": "Reset all progress for this content",

  /** Settings (in a browser tab): the tip behind the Progress "?". */
  "wording.browser.progressTip":
    "Saved in this browser as you read. Export and Import carry it to another browser.",
  /** Notice pill (browser tab): a confirmed import that storage refused. */
  "wording.browser.importFailed":
    "The import failed: this browser's storage refused it. Nothing was changed.",
  /** Settings (browser tab): accessible name of the Import button. */
  "wording.browser.importAria":
    "Import progress from a file, replacing this browser's",
  /** Import confirmation (browser tab); {story} is the game's name or "this story". */
  "wording.browser.importConfirm":
    "Replace this browser's progress for {story} with the imported file?",
  /** Settings (game app): the tip behind the Progress "?". */
  "wording.app.progressTip":
    "Saved as you read. Export and Import carry it to another device.",
  /** Notice pill (game app): a confirmed import that storage refused. */
  "wording.app.importFailed":
    "The import failed: this computer's storage refused it. Nothing was changed.",
  /** Settings (game app): accessible name of the Import button. */
  "wording.app.importAria":
    "Import progress from a file, replacing the progress saved here",
  /** Import confirmation (game app); {story} is the game's name or "this story". */
  "wording.app.importConfirm":
    "Replace the progress saved here for {story} with the imported file?",
  /** Import confirmation: stands for {story} when the game names itself nothing. */
  "wording.thisStory": "this story",

  /** Settings: the heading over the window controls. */
  "window.section": "Game window",
  /** Settings, Game window: the label of the Fullscreen | Window switch (read by screen readers). */
  "window.display": "Display",
  /** Settings, Game window: one half of the display switch. */
  "window.fullscreen": "Fullscreen",
  /** Settings, Game window: the other half of the display switch. */
  "window.window": "Window",
  /** Settings, Game window: the button that quits (short). */
  "window.exit": "Exit",
  /** Settings, Game window: the Exit row's label and the button's accessible name. */
  "window.exitLabel": "Exit the game",
  /** Notice pill: a browser tab the page may not close. */
  "window.closeTab": "This browser keeps the tab open: close the tab to exit.",

  /** Confirmation box: the button that changes nothing. */
  "confirm.cancel": "Cancel",
  /** Confirmation box, reset: its heading. */
  "confirm.reset.title": "Reset progress",
  /** Confirmation box, reset: the question. */
  "confirm.reset.message":
    "Reset all progress for this content? This clears resume position, seen items, routes, bookmarks and settings.",
  /** Confirmation box, reset: the confirming button (short). */
  "confirm.reset.button": "Reset",
  /** Confirmation box, reset: the keys under the buttons. */
  "confirm.reset.hint": "{yes} resets; {esc} or {no} cancels",
  /** Confirmation box, import: its heading. */
  "confirm.import.title": "Import progress",
  /** Confirmation box, import: the confirming button (short). */
  "confirm.import.button": "Import",
  /** Confirmation box, import: the keys under the buttons. */
  "confirm.import.hint": "{yes} imports; {esc} or {no} cancels",
  /** Confirmation box, removing the voice model: its heading. */
  "confirm.removeVoices.title": "Remove voice model",
  /** Confirmation box, removing the voice model: the question. */
  "confirm.removeVoices.message":
    "Remove the voice model from this computer to free its space? Every Kinetic game uses it; you can download it again.",
  /** Confirmation box, removing the voice model: the confirming button (short). */
  "confirm.removeVoices.button": "Remove",
  /** Confirmation box, removing the voice model: the keys under the buttons. */
  "confirm.removeVoices.hint": "{yes} removes; {esc} or {no} cancels",

  /** Decision screen: the last row, back to the story's main line. */
  "choice.continue": "Return to main route",
  /** Decision screen: beside a route already played. */
  "choice.seen": "seen",
  /** Decision screen: the hint under the question. */
  "choice.hint": "1-9 or click picks a route",
  /** Decision screen: the hint with more than nine routes ({enter} is the key). */
  "choice.hintLong": "1-9, arrows and {enter}, or click picks a route",
  /** Decision screen: added to the hint when the return row is there. */
  "choice.hintContinue": "; 0 returns",
  /** Decision screen: added to the hint while play-all is about to pick ({space} is the key). */
  "choice.hintAutoPick": "; {space} picks now",
  /** Decision screen, play-all: the countdown line; {seconds} left. */
  "choice.autoPick": "Play all routes picks in {seconds} s",
  /** Decision screen, play-all, after a jump back: {label} is the route just finished (game text). */
  "choice.autoPickBack":
    "Back in time: “{label}” is done. Play all routes picks in {seconds} s",

  /** At an ending, top of the screen: everything has been seen. */
  "endcard.allSeen": "You have seen everything.",
  /** At an ending: no routes left, but other content unseen. */
  "endcard.someUnseen": "Some content is still unseen.",
  /** At an ending: {count} routes and other content unseen. */
  "endcard.routesAndOther": {
    one: "{count} route and other content still unseen.",
    other: "{count} routes and other content still unseen.",
  },
  /** At an ending: {count} routes unseen. */
  "endcard.routes": {
    one: "{count} route still unseen.",
    other: "{count} routes still unseen.",
  },
  /** At an ending, under the count: the key to the next unseen content. */
  "endcard.next": "Press {key} for the next one.",
  /** On a resume, top of the screen: unseen content earlier on ({key} is U). */
  "endcard.earlierUnseen": "Earlier content you haven't seen - press {key}.",

  /** Pill: skip mode started. */
  "pill.skipOn": "Skip on",
  /** Pill: skip mode stopped. */
  "pill.skipOff": "Skip off",
  /**
   * Pill: Play all routes skips through a scene several routes share,
   * read already on an earlier route of this pass.
   */
  "pill.readAgain": "Read already: skipping",
  /** Pill: auto-forward turned on. */
  "pill.autoForwardOn": "Auto-forward on",
  /** Pill: auto-forward turned off. */
  "pill.autoForwardOff": "Auto-forward off",
  /** Pill: sound turned on. */
  "pill.soundOn": "Sound on",
  /** Pill: sound turned off. */
  "pill.soundOff": "Sound off",
  /** Pill: a bookmark was saved. */
  "pill.bookmarked": "Bookmarked",
  /** Pill: the story jumped back in time to take another route. */
  "pill.backJump": "Back to try another route",
  /** Pill: the route just entered; {label} is its name (game text). */
  "pill.route": "Route: {label}",
  /** Pill on a video with several camera views: which view, {index} of {count}. */
  "pill.segment": "View {index} of {count}",
  /** Pill until the browser allows sound. */
  "audio.soundHint": "Press any key for sound",

  /** Shown instead of a picture: the game folder has no items at all. */
  "visual.empty": "No content yet — this folder has an empty manifest.",
  /** Shown instead of a picture: nothing to draw here. */
  "visual.nothing": "No content to show.",
  /** Shown instead of a picture in a broken game: {id} is the item's identifier. */
  "visual.placeholder": "{id} — text item with no visual",

  /** Volumes sheet: its heading. */
  "volumes.title": "Volumes",
  /** Volumes sheet: the key that closes it. */
  "volumes.hint": "{esc} closes",
  /** Volumes sheet: the closing button. */
  "volumes.done": "Done",
  /** Volumes sheet: the music row. */
  "volumes.music": "Music",
  /** Volumes sheet: accessible name of the music slider. */
  "volumes.music.slider": "Music volume",
  /** Volumes sheet: accessible name of the music minus button. */
  "volumes.music.decrease": "Decrease music volume",
  /** Volumes sheet: accessible name of the music plus button. */
  "volumes.music.increase": "Increase music volume",
  /** Volumes sheet: the sound effects row. */
  "volumes.effects": "Effects",
  /** Volumes sheet: accessible name of the effects slider. */
  "volumes.effects.slider": "Effects volume",
  /** Volumes sheet: accessible name of the effects minus button. */
  "volumes.effects.decrease": "Decrease effects volume",
  /** Volumes sheet: accessible name of the effects plus button. */
  "volumes.effects.increase": "Increase effects volume",
  /** Volumes sheet: the spoken lines row. */
  "volumes.voice": "Voice",
  /** Volumes sheet: accessible name of the voice slider. */
  "volumes.voice.slider": "Voice volume",
  /** Volumes sheet: accessible name of the voice minus button. */
  "volumes.voice.decrease": "Decrease voice volume",
  /** Volumes sheet: accessible name of the voice plus button. */
  "volumes.voice.increase": "Increase voice volume",
  /** Volumes sheet, Voice row: the small button that removes the installed voice model. */
  "volumes.remove": "Remove voice model",
  /** Volumes sheet: accessible name of the remove button. */
  "volumes.removeAria":
    "Remove the voice model from this computer to free its space",
  /** Volumes sheet: accessible name of the "?" beside the voice model's download. */
  "volumes.model.about": "About the voice model",
  /** Volumes sheet: accessible name of the voice model's download progress bar. */
  "volumes.model.progress": "Voice model download",
  /** Volumes sheet: stops the voice model's download (short). */
  "volumes.model.cancel": "Cancel",
  /** Volumes sheet: accessible name of the download's Cancel. */
  "volumes.model.cancelAria": "Cancel the voice model download",
  /** Volumes sheet: tries the failed download again (short). */
  "volumes.model.retry": "Retry",
  /** Volumes sheet: accessible name of Retry. */
  "volumes.model.retryAria": "Retry the voice model download",
  /** Volumes sheet, Voice row: until the game app says the voice model's state. */
  "voice.checking": "Checking…",
  /** Volumes sheet, the voice model's "?": a computer that cannot make spoken lines. */
  "voice.unsupported": "Spoken lines are not available on this computer.",
  /** Volumes sheet: the voice model's download failed. */
  "voice.failed": "The voice model could not be downloaded.",
  /** Volumes sheet: the download button; {size} is its size, e.g. 3.3 GB. */
  "voice.download": "Download voice model ({size})",
  /** Volumes sheet: the tip behind the download's "?"; {size} is its size. */
  "voice.help":
    "Spoken lines are made on this computer from the characters' voices. The voice model is downloaded once ({size}) and every Kinetic game on this computer shares it.",
  /** Volumes sheet: a game app's voice problem the player has no words for; {text} is the general message above ("could not be downloaded" or "not available"), {detail} the app's own reason, in English. */
  "voice.detail": "{text} ({detail})",
  /** Volumes sheet, the voice model's "?" (a Mac app): this Mac has an Intel processor. */
  "voice.code.apple-silicon": "Spoken lines need a Mac with Apple silicon.",
  /** Volumes sheet, the voice model's "?" (a Mac app): {version} is the macOS version needed, e.g. 14.0. */
  "voice.code.macos-version": "Spoken lines need macOS {version} or later.",
  /** Volumes sheet, the voice model's "?": the computer's operating system is too old for the voice packages. */
  "voice.code.unsupported-system":
    "Spoken lines need a newer operating system on this computer.",
  /** Volumes sheet, the voice model's "?" (a Windows app): the PC has no NVIDIA graphics card. */
  "voice.code.no-nvidia":
    "Spoken lines need an NVIDIA graphics card. This computer doesn't have one.",
  /** Volumes sheet, the voice model's "?" (a Windows app): {version} is the NVIDIA driver version needed, e.g. 570.65. */
  "voice.code.nvidia-driver":
    "Spoken lines need NVIDIA driver {version} or later. Update the graphics driver to use them.",
  /** Volumes sheet: not enough disk space for the voice model; {need} and {free} are sizes, e.g. 7.8 GB. */
  "voice.code.disk-space":
    "Spoken lines need {need} of free disk space; this computer has {free} free. Free some space, then try again.",
  /** Volumes sheet: a part of the voice model's download failed (the network or the server). */
  "voice.code.download-failed": "A download failed. Try again to continue it.",
  /** Volumes sheet: a downloaded part of the voice model was damaged and was deleted. */
  "voice.code.hash-mismatch":
    "A download did not match its checksum. Try again.",
  /** Volumes sheet: installing the downloaded voice packages failed. */
  "voice.code.pip-failed": "Installing the voice packages failed.",
  /** Volumes sheet: the voice model's install failed for another reason. */
  "voice.code.install-failed": "The voice install failed.",
  /** Volumes sheet: the folder the voice model goes in could not be created or written. */
  "voice.code.folder-failed": "The voice folder could not be written.",
  /** Volumes sheet: the program that makes spoken lines could not start. */
  "voice.code.helper-failed": "The voice helper could not start.",
  /** Volumes sheet: the program that makes spoken lines stopped. */
  "voice.code.helper-crashed": "The voice helper stopped unexpectedly.",
  /** Volumes sheet: the voice setup inside the game app is damaged. */
  "voice.code.lock-failed": "This app's voice setup cannot be read.",

  /** Branch map: its heading. */
  "map.title": "Branch map",
  /** Branch map: the Spoilers switch, on (decisions not reached show their words). */
  "map.spoilers.on": "Spoilers: On",
  /** Branch map: the Spoilers switch, off (the default). */
  "map.spoilers.off": "Spoilers: Off",
  /** Branch map header button: go to the newest bookmark. */
  "map.newest": "Newest bookmark",
  /** Branch map header button: centre the view on where the reader is. */
  "map.centre": "Centre",
  /** Branch map header button: the map at full size, scrolling. */
  "map.full": "Full size",
  /** Branch map header button: the whole map fitted to the screen. */
  "map.fit": "Fit",
  /** Branch map: the hint on a header button; {key} is its key. */
  "map.shortcut": "shortcut: {key}",
  /** Branch map: the label under the reader's position marker (lower case). */
  "map.here": "you are here",
  /** Branch map: the note after a bookmark's ×. */
  "map.toast.deleted": "Bookmark deleted",
  /** Branch map: the button in that note; {key} is its key (Z). */
  "map.toast.undo": "Undo ({key})",
  /** Branch map: a bookmark card's accessible name; {time} is when it was made. */
  "map.card.label": "Bookmark {time}",
  /** Branch map: the newest bookmark card's accessible name. */
  "map.card.labelNewest": "Bookmark {time} (newest)",
  /** Branch map: a bookmark card's × (accessible name and hint). */
  "map.card.delete": "Delete this bookmark",
  /** Branch map: a deleted card, until it fades (short). */
  "map.card.deleted": "Deleted",
  /** Branch map: brings a deleted card back (short). */
  "map.card.undo": "Undo",
  /** Branch map tooltip and accessible name: {title}, then {status}. */
  "map.node.label": "{title}: {status}",
  /** Branch map tooltip: a route's title, {number}. {label} (label is game text). */
  "map.route.title": "{number}. {label}",
  /** Branch map, a route's status: never entered. */
  "map.route.unseen": "not seen",
  /** Branch map, a route's status: entered, not finished. */
  "map.route.partly": "partly seen",
  /** Branch map, a route's status: played through. */
  "map.route.played": "played",
  /** Branch map, a route's outcome: it joins the story again. */
  "map.route.continues": "continues the story",
  /** Branch map, a route's outcome: it comes back to its decision. */
  "map.route.returns": "returns to the choice",
  /** Branch map, a route's outcome: it ends the story. */
  "map.route.ends": "an ending",
  /** Branch map, a route's outcome: it goes on to a scene several routes share. */
  "map.route.shared": "goes on to a shared scene",
  /** Branch map tooltip: a box for a scene several routes go on to, drawn once. */
  "map.span.title": "Shared scene",
  /** Branch map, a route's status: the route last picked there. */
  "map.route.lastPick": "your last pick",
  /** Branch map, a route's status: its decision not reached. */
  "map.route.notReached": "decision not reached yet",
  /** Branch map, a decision's status: {played} of its {count} routes played. */
  "map.decision.played": {
    one: "{played} of {count} routes played",
    other: "{played} of {count} routes played",
  },
  /** Branch map, a decision's status: not reached yet. */
  "map.decision.notReached": "not reached yet",
  /** Branch map, Spoilers off: stands for a decision's question not reached. */
  "map.hidden.prompt": "Decision not reached",
  /** Branch map, Spoilers off: stands for a route's name not reached. */
  "map.hidden.route": "Unseen route",
  /** Branch map, beside a stretch of story: its length in screens. */
  "map.count.screens": {
    one: "{count} screen",
    other: "{count} screens",
  },
  /** Branch map, beside a stretch of story: its bookmarks. */
  "map.count.bookmarks": {
    one: "{count} bookmark",
    other: "{count} bookmarks",
  },

  /** Import refused: the file is not JSON. */
  "transfer.notJson":
    "That file is not a Kinetic progress file (it is not JSON).",
  /** Import refused: the file is JSON but not a progress file. */
  "transfer.notProgress": "That file is not a Kinetic progress file.",
  /** Import refused: another file version; {theirs} as written in it, {ours} a number. */
  "transfer.version":
    "That progress file is version {theirs}; this player reads version {ours}.",
  /** Import refused: the file's story ID is damaged. */
  "transfer.damaged.storyId":
    "That progress file is damaged: its story ID is missing or malformed.",
  /** Import refused: the file's saved state is damaged. */
  "transfer.damaged.state":
    "That progress file is damaged: its state is missing or malformed.",
  /** Import refused: the file's bookmarks are damaged. */
  "transfer.damaged.bookmarks":
    "That progress file is damaged: its bookmarks are missing or malformed.",
  /** Import refused: another game's file; {theirs} and {here} name the two games (the phrases below). */
  "transfer.otherStory": "That file holds progress for {theirs}, not {here}.",
  /** Names a game by its title in the message above; {title} is game text. */
  "transfer.story.titled": '"{title}"',
  /** Names a game by its story ID in the message above. */
  "transfer.story.id": 'the story "{id}"',
  /** Names a file's game that has neither title nor ID, in the message above. */
  "transfer.story.noId": "a story without an ID",
  /** Names this game, untitled, in the message above. */
  "transfer.story.this": "this story",

  /** Mac app menu (the menu named after the game): hides the app; {title} is the game's title. */
  "host.menu.hide": "Hide {title}",
  /** Mac app menu (the menu named after the game): quits the app; {title} is the game's title. */
  "host.menu.quit": "Quit {title}",
  /** Mac app: the View menu's name in the menu bar. */
  "host.menu.view": "View",
  /** Mac app, View menu: reloads the game's page (the reader keeps their place). */
  "host.menu.reload": "Reload",
  /** Mac app, View menu: switches between full screen and a window (macOS's own wording). */
  "host.menu.fullScreen": "Toggle Full Screen",
  /** Mac app, an alert before the game opens: the app is not in its game folder; {title} is the game's title. */
  "host.mac.missing.title": "{title} cannot find its game.",
  /** Mac app, the alert above: what to do; {file} is the page's file name (index.html), kept as written. */
  "host.mac.missing.text":
    "This app plays the {file} file in the folder it sits in, and there is none next to it. Keep the app inside its game folder. If the game folder was downloaded, open {file} in it instead.",
  /** Mac app, the alert above: its only button, which quits the app. */
  "host.mac.missing.quit": "Quit",
  /** Windows program, an error box before the game opens: the program is not in its game folder; {title} is the game's title, {file} the page's file name (index.html), kept as written; the blank line stays. */
  "host.windows.missing":
    "{title} cannot find {file} next to this program.\n\nKeep the program inside its game folder, or open the folder's {file} instead.",

  /** Converter words, not the player's: written into a converted game as the prompt of a decision made from a condition in the script (what the story so far decides); the reader picks the route that matches their earlier choices. */
  "converter.condition.prompt": "Which fits your story so far?",
  /** Converter words: a route label of a decision made from a condition; {choice} is the game's own text of an earlier choice (or several, joined by the "or" words below). */
  "converter.condition.chose": "If you chose: {choice}",
  /** Converter words: joins two alternatives in a route label, choices ({first} the game's text of one choice, or of several already joined) or number ranges ("love under 1 or love 3 or more"). */
  "converter.condition.or": "{first} or {second}",
  /** Converter words: a route label for a counter; {name} is the game's name for it (e.g. love), {n} a whole number: the counter is {n} or higher. */
  "converter.condition.atLeast": "{name} {n} or more",
  /** Converter words: a route label for a counter; {name} is the game's name for it, {low} and {high} whole numbers at least two apart: the counter is from {low} to {high}, both included. */
  "converter.condition.between": "{name} {low} to {high}",
  /** Converter words: a route label for a counter; {name} is the game's name for it, {low} and {high} two whole numbers in a row (1 and 2): the counter is one or the other. */
  "converter.condition.either": "{name} {low} or {high}",
  /** Converter words: a route label for a counter; {name} is the game's name for it, {n} a whole number: the counter is exactly {n}. */
  "converter.condition.exactly": "{name} exactly {n}",
  /** Converter words: a route label for a counter; {name} is the game's name for it, {n} a whole number: the counter is below {n}. */
  "converter.condition.under": "{name} under {n}",
  /** Converter words: the route label of the last case of a decision made from a condition, when the rest cannot be put in words. */
  "converter.condition.otherwise": "Otherwise",
  /** Converter words: a route label; {name} is the game's name for something the story has or has not done (e.g. met_sam): it has. */
  "converter.condition.set": "{name} is set",
  /** Converter words: a route label; {name} is the game's name for something the story has or has not done: it has not. */
  "converter.condition.notSet": "{name} is not set",
  /** Converter words: a route label; {name} is the game's name for a setting of the story, {value} the game's own value for it (e.g. ending is good). */
  "converter.condition.is": "{name} is {value}",
  /** Converter words: a route label; {name} is the game's name for a setting of the story, {value} the game's own value it does not have. */
  "converter.condition.isNot": "{name} is not {value}",
  /** Converter words: a line of the story showing a route label ({label}, one of the labels above) in parentheses, for a route with no line of its own. */
  "converter.condition.aside": "({label})",
} as const satisfies Record<string, Message>;
