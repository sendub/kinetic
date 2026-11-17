# Game apps

`macos/` holds the macOS app (`app/`, Swift over the system WebKit) and the
scenario suite's WebKit driver (`driver/`), which share
`macos/WebViewSetup.swift`, `macos/VoiceEngine.swift` and
`macos/HostWords.swift`. `windows/` holds
the Windows exe (Go's standard library over WebView2). `voice/` holds the
voice helper both apps run for spoken lines (`voice/README.md`).
`tools/build_apps.py` builds them into a game folder (CREATE.md, "Building
the apps").

## Keys in the macOS app

The page takes every key it owns, a held key's repeats included
(`player/src/render/keys.ts`, `installKeyMap`). A key held with ⌘, Ctrl or
Alt is never one of them: the page runs nothing on it and leaves it, so the
browser or the app acts on it. WKWebView hands a keydown the page did not
take back to AppKit (`NSApp.sendEvent`, then up the responder chain to the
window), and NSWindow's own `keyDown` would run AppKit's keyboard
interface on it: Tab moves the key view, Esc can take a fullscreen window
out of fullscreen, and anything else beeps. So the game window,
`KineticWindow` in `macos/WebViewSetup.swift`, drops every key that
reaches its `keyDown`, and its `cancelOperation` does nothing (an Esc the
page did not take, or ⌘., arrives that way too).

The menus' shortcuts (⌘Q, ⌘R, ⌃⌘F) work because the page leaves every
key held with ⌘. NSApp offers a key equivalent to the window's views
before the main menu and before any keyDown reaches a window, and
WKWebView claims it to give the page its turn. When the page leaves it,
WebKit sends it through NSApp again, the web view lets it pass, and the
main menu gets it. A key equivalent the page takes never reaches the menu:
the page once took ⌘H as `h` and hid the text. The page leaves ⌘H now,
but in the app it does nothing visible (the user's play check,
2026-11-09), so it is not one of the shortcuts readers are told about.

The driver's window is a `KineticWindow` too. Each key that comes back to
it becomes a `windowkey` line, `dropped` where the window drops it and
`appkit` if it ever reaches NSWindow's own `keyDown`; the `window`
scenario's held-keys checks read them (docs/verify-player.md). The driver
never becomes the active app, so AppKit gives it no key window and makes
no key-equivalent pass. Its NSApp, `DriverApplication`, makes that pass on
the driver's window for a keydown held with ⌘ and reports the window's
answer as a `keyequivalent` line. The `window` scenario's ⌘H check reads
them: claimed for the page's turn, then unclaimed once the page leaves it,
where the game app's main menu is offered it.

## Sound at launch

Both apps let the page play sound with no key or click first, so a game
with sound plays it from launch and never shows the "Press any key for
sound" hint a browser needs (docs/stack.md, "Audio decision"). The page
plays at launch only when the app's host bridge (`window.kineticHost`,
The page-to-host protocol, below) is there as it loads; without it, as
in a browser, it waits for a key whatever the engine allows.

- macOS: `macos/WebViewSetup.swift` sets
  `mediaTypesRequiringUserActionForPlayback = []`. The WebKit driver
  shares that setup; its test-only `--require-gesture-for-audio` sets
  `.audio` there instead, so the scenarios test the hint as Safari shows
  it (docs/verify-player.md).
- Windows: before it creates the WebView2 environment, the exe sets
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, which the WebView2 runtime
  reads at that point, to the reader's own value of the variable followed
  by Chromium's `--autoplay-policy=no-user-gesture-required`. A reader's
  value that already names an `--autoplay-policy` is kept as it is
  (`windows/launch.go`, `webViewEnvironment`). Microsoft lists the flag
  but discourages browser flags in production apps. `go test` checks the
  variable the exe sets; that WebView2 then plays sound at launch is not
  verified on Windows. If it refuses a play, the page shows its hint as
  in a browser.

## The page-to-host protocol

One protocol serves both apps (docs/plan.md Phase 43 item 9). The page side
is `player/src/render/host.ts`; the macOS side is `KineticHostBridge` in
`macos/WebViewSetup.swift`; the Windows side is `windows/host.go` and
`windows/webview_windows.go`.

- The host gives the page `window.kineticHost = { kind, display,
  send(message) }`. `kind` is `"mac-app"` or `"windows-app"`, and the page
  treats both alike. `display` is `"fullscreen"` or `"window"`. The object
  may arrive after the page loads.
- Whenever the object appears, or its `display` changes, the host fires a
  plain `kinetic-host` event on `window`. A change the reader makes with the
  system's own controls counts too.
- The page sends `{ type: "quit" }` for Exit and `{ type: "display", mode }`
  for a half of the Esc screen's Fullscreen | Window switch, only when it
  differs from `display`. The switch shows `display` and waits for the
  event: the page never assumes the switch happened.
- The host owns the mode and its memory. It reopens in the mode it was left
  in, with no fullscreen flash when that is a window. Its first window takes
  the first graphic's pixel size, which the build bakes in (Info.plist
  `KineticWindowSize` on macOS, `-ldflags -X main.firstWindowSize` on
  Windows), scaled down to fit the screen; a size the reader sets is kept.
- With a host present the page never asks for element fullscreen. Without
  one (a browser tab) the page keeps a Display setting with its other
  settings and uses the Fullscreen API.
- The page sends `{ type: "language", ui, dir, title? }` (docs/plan.md
  Phase 54 item 7): `ui` the tag of the language its own words are in
  (the player's UI language, a catalogue language), `dir` `"ltr"` or
  `"rtl"`, and `title` the game's title as shown, in the language shown,
  absent when the game has none. It sends it as soon as the host object
  is there (at load, or at the `kinetic-host` event that brings it), again
  once the manifest gives the title, and on every change of the UI
  language or of the game's language; never the same message twice
  running. The host draws its own words in `ui` and titles its window
  with `title`, else the game's title it was built with (The apps' own
  words, below).

On macOS a user script at document start defines the object, `send` posts
to the `kineticHost` script message handler, and the app reports each
change through `setDisplay`, which also swaps the user script so a reload
starts with the mode in force. The WebKit driver installs the same bridge
with a recording host, so the scenarios test the page against the real
Swift side (docs/verify-player.md, "WebKit").

On Windows the exe is the host: it opens a window of its own and shows
the page in it through WebView2, the Edge engine Windows provides to apps.

- It finds the installed Evergreen WebView2 Runtime itself, with no
  WebView2Loader.dll beside it (`windows/runtime.go` names its sources):
  the runtime's folder from its EdgeUpdate registry keys, then
  `EBWebView\x64\EmbeddedBrowserWebView.dll` there, whose environment
  export it calls as Microsoft's loader does. The game's WebView2 data
  folder is `%LOCALAPPDATA%\Kinetic\WebView2\<storyId>`. Without the
  runtime, or when the web view cannot be created, the exe opens
  `index.html` in the default browser.
- A script WebView2 runs as each document is created defines the object
  in the top document (`windows/host.go`, `hostScript`); `send` posts
  with `window.chrome.webview.postMessage`. The exe takes a message only
  from the game's own page (it checks the sender's URL). On a mode change
  it runs the setter in the page and swaps the creation script, so a
  reload starts in the mode in force.
- Fullscreen is the window with no frame covering its whole monitor; a
  window has the usual frame. The switch keeps the window's placement
  (`GetWindowPlacement`, then `SetWindowPlacement`, each with
  `SWP_FRAMECHANGED`). WebView2 does not treat this as fullscreen, so
  there is no notice and every key, Esc held or not, is the page's.
- The browser's own keys are off (find, print, zoom, dev tools, reload),
  and so are the context menu, zoom by wheel or pinch and the status bar.
  The exe keeps three keys from the page: F11 switches the mode, and F5
  and Ctrl+R reload.
- It keeps the mode, the last plain window's place and size, and whether
  it was maximized in `kinetic-window.json` in the data folder, and opens
  straight in that mode: frameless over the monitor the window was on, or
  at the remembered place while that monitor is connected. The first
  window is the baked size fitted to the work area with a margin,
  centred. The exe is per-monitor DPI aware (its manifest), so it works
  in the monitor's pixels and counts the baked size as CSS pixels.
- Export saves into Downloads under a free name (`name (2).json` and so
  on) with no download bubble; Import uses WebView2's own file dialog. A
  page whose renderer ended reloads, a web view whose browser process
  ended is made again, and new windows are refused.
- A second launch while the game is open (a mutex named for the storyId)
  brings the game's window (class `KineticGame-<storyId>`) forward and
  exits.
- Each run logs to `kinetic-host.log` in the data folder: the registry
  values and the runtime chosen, each creation step's HRESULT, mode
  switches and the page's messages.

`go test` in `windows/` covers the decisions on any OS: the window plan
and memory, the host script (run in Node when it is installed), the
message and sender checks (the language message and the title it gives
the window too), the keys, download names, finding the runtime, the
environment variables it sets for WebView2, and the words table (its
language matching against the shared cases, the lookup and its English
fallback, and reading `GetUserPreferredUILanguages`' list). Running the
exe on Windows is a manual check.

The voice host's decisions are tested the same way, on any OS
(`voice_test.go`, `voice_engine_test.go`, `voice_fetch_test.go`): the lock
and its totals, the download base, the state machine, id mapping, relaying
a helper's events, drop, remove, the restart policy, the Range resume and
checksum, the unpacking (and the archives it refuses), and the whole
engine against the repo's helper with its fake engine. Only
`voice_windows.go` (the free-space call, the hidden process, the window
message that moves events to the UI thread, where every WebView2 call is
made) runs on Windows alone. The orchestrator's check there is a
cross-compiled `go test -c` binary that runs the engine without a window
against the real Python download. A windowed exe's own run, with a real
game, is a manual check. `tools/build_apps.py --windows` stops with an
error when `voice/lock-windows-x64.json` is missing.

## The apps' own words

What the apps draw themselves comes from the player's catalogue, in all
its languages (docs/plan.md Phase 54 item 7; docs/verify-player.md, "The
player's words"): the `host.*` messages of `player/src/i18n/en.ts` and
`player/locales/<tag>.po`, which `npm run i18n` writes to
`apps/host-words.json` (committed; `npm test` fails while it is stale).
`tools/build_apps.py` embeds it in each app and stops when it is stale
against the catalogue (a digest of `en.ts` and the PO files is in it):

| Key | Where |
| --- | --- |
| `host.menu.hide`, `host.menu.quit` | The Mac app menu's Hide and Quit items, `{title}` the shown title. |
| `host.menu.view`, `host.menu.reload`, `host.menu.fullScreen` | The Mac View menu, its Reload and Toggle Full Screen. |
| `host.mac.missing.title`, `.text`, `.quit` | The Mac alert when the app finds no `index.html` beside it. |
| `host.windows.missing` | The exe's error box when it finds no `index.html` beside it. |

The Mac menus have only these items: there is no About, Hide Others or
Show All item to translate. The window title is the game's title alone,
with no words around it. Words that stay English: the exe's error box for
an exe built outside `tools/build_apps.py` ("built without its game's
details"), which only an author can meet, and the English detail of a
voice status (`message`, for the log; the page shows its `code`'s words).

Before the page loads, an app picks the language from the system's
preferred languages (`Locale.preferredLanguages` on macOS, the user's
display languages from `GetUserPreferredUILanguages` on Windows) by the
player's own rule (`bestLanguageMatch` in
`player/src/i18n/languages.ts`): the first preferred language with a
match in the table, a match being the same tag, else the same language
and script (likely subtags filled in, so `zh-TW` takes `zh-Hant`) with the
same region, a region group (`es-MX` takes `es-419`) or no region; else
English. `apps/host-language-cases.json` holds cases the player
(`languages.test.ts`), the exe (`hostwords_test.go`) and the Mac app (the
`machost` scenario, through the WebKit driver) all check. A language
message then moves the Mac menus to `ui` and both windows' titles to
`title`.

- macOS: `macos/HostWords.swift` (shared with the WebKit driver) reads
  the table, compiled in as a generated `KineticHostWordsEmbedded.swift`
  (base64, never committed; `tools/build_apps.py` and
  `player/scripts/webkit/build.mjs` write the same text), matches the
  language, and gives the menu and alert words; `KineticHostBridge` hands
  each language message to the app's `onLanguage`. The app's window
  still follows the page's `document.title` too, which is the same title.
- Windows: `windows/hostwords.go` (platform-neutral, tested on any OS)
  reads the table, which the build copies into the package as
  `hostwords.json` with a generated `hostwords_embedded.go` (never
  committed); a build without it (`go test`) uses the built-in English,
  which `hostwords_test.go` holds to the table's. On a language message
  the exe sets its window's text (`languageTitle`); the document-title
  handler keeps doing so for an older page.

## Spoken lines

The macOS app offers spoken lines (docs/plan.md Phase 52): `VoiceEngine`
in `macos/VoiceEngine.swift`, which the app hands to `KineticHostBridge`.
The WebKit driver compiles the same file. The Windows exe offers them too
(`windows/voice.go`, `voice_engine.go`, `voice_fetch.go`,
`voice_windows.go`), with the same bridge and the same helper; the notes
below say where it differs.

### The voice bridge

With a voice host, `window.kineticHost` also has `voice: true`. The page
sends `kineticHost.send({ type: "voice", op, ... })`, from the main frame
only (a subframe's messages are dropped, as its other messages are). The
host answers by calling `window.__kineticVoice(event)`, which the page
defines when it starts. An event that finds no such function is dropped,
except the latest status: the bridge keeps it and sends it before it
handles the page's next voice message.

The player talks to the voice host only when some line needs the model: an
item with text, a cast voice and no recorded `audio.voice`. A game whose
lines are all recorded, or that casts no voice, sends the host nothing. A
game with voices and language files talks to it whenever the host offers
voice, since another language may need the model (docs/content-format.md,
"Translations"). The
status shows in the Volumes box's Voice row (a download button, progress,
an error, a greyed button for `unsupported`, or the slider once `ready`).

| Page sends (`op`) | Fields | What happens |
| --- | --- | --- |
| `status` | | A `status` event. |
| `install` | | Downloads Python, then runs the helper's install, with `status` events. |
| `cancel` | | Stops the install; partial downloads stay, so the next `install` continues them. |
| `remove` | | Stops any install and the helper, deletes the whole install, then `status` absent. |
| `voice` | `id`, `data` (the reference clip, base64), `format` (its extension: `wav`, `flac` or `mp3`), `text`? | A `voice` event. |
| `speak` | `id`, `voiceId`, `text`, `priority`, `lang`, and any other field the helper takes (`stream`), passed on | A `speech` event, or `dropped` or `error`. |
| `drop` | `id` (a `speak`'s) | Cancels the line if it is still queued; either way the page gets `dropped` for it, once, never its `speech`. An id with no line in progress is ignored. |

| Event (`event`) | Fields |
| --- | --- |
| `status` | `state`: `absent`, `installing`, `ready`, `error` or `unsupported`; `downloadBytes` (the whole install, Python included); with `installing`, `done` and `total` on one scale across the Python download and the helper's progress; with `error` and `unsupported`, `code` (below), the code's own fields, and `message`, an English detail for logs. Sent on every change and in answer to `status`, `install` and `cancel`, progress at most four times a second. |
| `voice` | `id`, `voiceId` (the clip's sha256). |
| `speech` | `id`, `wav` (base64 WAV, 24 kHz 16-bit mono), `seconds`, and the helper's `genSeconds` and `cached`. |
| `dropped` | `id`. |
| `error` | `id`, `code` (the helper's codes, apps/voice/README.md, plus `not-installed` before the install, `helper-crashed` and `helper-stopped`), `message`. |
| anything else | A helper event that names a request (`target`), such as a streamed line's chunks, passed on as `{ event, id: <the page's id>, ...the rest }`. |

`lang` is the engine's language for the text (docs/plan.md Phase 54 item
6): the player sends the language the line is shown in, as the engine
names it (`de`, `ja`, `ar`, `pt` for `pt-BR`, `no` for `nb`), and the base
language's for a line shown untranslated, so a German-base game speaks
German. A line in a language the engine does not speak is never asked
for; the helper refuses one with `bad-request` (apps/voice/README.md,
"The protocol", lists the 23). Both hosts pass the field on as the page
sent it, and the helper's line cache keys on it.

`unsupported` means a Mac without Apple silicon, or a macOS older than
every build of some package in the lock (the helper's
`unsupported-system`); its message names the macOS needed. On Windows it
means no NVIDIA card, or a driver older than the lock's `cudaMinDriver`
(570.65); `downloadBytes` is still the whole download (6.83 GB) so the
page can show its greyed button, with the reason in its ? help. An
install first checks that the volume has the whole download plus 1 GB
free, and reports `error` saying how much it needs and has.

The page shows the player's words for a status's `code` in the reader's
language (`voice.code.<code>` in the catalogue; docs/plan.md Phase 54 item
7), never the English `message`; for a code it does not know, or none (an
app built before the codes), it shows its general words ("could not be
downloaded", "not available") with the `message` after them. The codes:

| `code` | State | Fields | When |
| --- | --- | --- | --- |
| `apple-silicon` | `unsupported` | | A Mac without Apple silicon. |
| `macos-version` | `unsupported` | `version` | A macOS older than every build of some package in the lock; `version` the oldest that works. |
| `unsupported-system` | `unsupported` | | The helper's `unsupported-system` (both apps). |
| `no-nvidia` | `unsupported` | | Windows: no NVIDIA card, or no working `nvidia-smi`. |
| `nvidia-driver` | `unsupported` | `version` | Windows: a driver older than the lock's `cudaMinDriver`, which `version` gives. |
| `disk-space` | `error` | `needBytes`, `freeBytes` | Less free space than the download plus 1 GB. |
| `download-failed` | `error` | | The Python download (network, HTTP, short, too long) or the helper's `download-failed`. |
| `hash-mismatch` | `error` | | The Python archive or the helper's download did not match its sha256. |
| `pip-failed` | `error` | | The helper's `pip-failed`. |
| `install-failed` | `error` | | Unpacking Python, or any other install failure (the helper's `install-failed` and unknown codes). |
| `folder-failed` | `error` | | The voice folder, its download or the helper's files cannot be written. |
| `helper-failed` | `error` | | The helper cannot start, or cannot report its state. |
| `helper-crashed` | `error` | | The helper stopped a second time. |
| `lock-failed` | `error` | | The lock built into the app is missing or unreadable. |

### The voice folder

`~/Library/Application Support/Kinetic/Voice/`, one per Mac, shared by
every Kinetic app. Nothing is written there until the page sends
`install`. The app owns `python/` (unpacked from the download, with
`.kinetic-python` holding the archive's sha256), `helper/` (the helper's
files and the lock, written from the binary when absent or different) and
`helper.log` (the helper's stderr and the app's notes on it, cut back past
4 MB); the helper owns the rest (apps/voice/README.md, "The voice
folder"). The Python archive downloads into `downloads/` as
`python-<sha>.tar.gz.partial`, continued with a Range request after a
cancel or a failure, checked against the lock's sha256 and unpacked with
`/usr/bin/tar` into `python.partial/` before it is moved into place.
`remove` deletes all of it, and the folder too when nothing else is in it.

The app downloads from three places, all pinned by sha256 in
`voice/lock-macos-arm64.json`: the Python build (25 MB) from
python-build-standalone's GitHub releases, fetched by the app; the wheels
from PyPI and the model files from Hugging Face (3.3 GB), fetched by the
helper.

On Windows the voice folder is `%LOCALAPPDATA%\Kinetic\Voice\`, one per
PC, shared by every Kinetic exe, and the lock is
`voice/lock-windows-x64.json` (Python 3.12 from python-build-standalone's
`x86_64-pc-windows-msvc-install_only` archive, 47 MB; one CUDA 12.8 build
of PyTorch, no CPU variant: spoken lines on Windows need an NVIDIA card).
The exe asks `nvidia-smi` once, on the first voice status (the one on the
PATH, else `System32\nvidia-smi.exe`; it runs with no console window and
is cut off after 15 s, and the answer is logged to `helper.log`'s sibling
log, `voice: nvidia-smi gave ...`). No card, a failing or missing
`nvidia-smi`, or a driver below `cudaMinDriver` is `unsupported`, and
`install` is refused in that state: nothing is written or downloaded.
The exe downloads
with `net/http` (progress, a Range request to continue a partial file,
the sha256 check) and unpacks the archive itself with Go's `archive/tar`
and `compress/gzip` into `python.partial\`, then moves it to `python\`:
no `tar.exe`, so nothing but the exe is needed. A name or link in the
archive that would leave the folder fails the unpacking. Python is
`python\python.exe`. The disk check is `GetDiskFreeSpaceExW`, counting
the user's quota. Windows cannot delete files a running program holds, so
`remove` stops the helper first and deletes once it has exited. The
helper runs with no console window (`CREATE_NO_WINDOW`), its stderr in
`helper.log`.

### The helper

The build embeds `voice/kinetic_voice/*.py` and the lock in the binary: it
writes them, base64, into a generated `KineticVoiceEmbedded.swift`, never
committed (`tools/build_apps.py` and `player/scripts/webkit/build.mjs`
write the same text), so the bundle's layout is unchanged. The app runs
`<voice>/python/bin/python3 -I -B <voice>/helper/kinetic_voice/__main__.py
--root <voice>` with pipes for stdin and stdout. It starts the helper for
`install` once Python is there, and for `status`, `voice` or `speak` once
an install of this lock has finished (its `state.json`). It maps each page
request id to an id of its own and back. If the helper exits unexpectedly
it starts it once more, registers the page's voices again and sends every
unanswered request again; a second crash is `status` error, until a
`status` or `install` starts it afresh. It stops the helper when the app
quits; a helper whose app was killed exits at the end of its input.

### Test overrides

Environment variables for the tests and the orchestrator's checks, never
for readers. A relative path in them, the helper command's included, is
taken from the app's working directory (the test helper command runs
there; the real helper runs in the voice folder):

| Variable | Effect |
| --- | --- |
| `KINETIC_VOICE_DIR` | The voice folder. |
| `KINETIC_VOICE_DOWNLOAD_BASE` | Every download URL `https://<host>/<path>` becomes `<base>/<host>/<path>`, in the lock written for the helper too, so a local server stands in for all three sources. |
| `KINETIC_VOICE_LOCK` | A lock file in place of the embedded one (the helper gets it too). |
| `KINETIC_VOICE_PYTHON` | A Python to run the embedded helper with; no Python download. |
| `KINETIC_VOICE_NVIDIA_SMI` | Windows only: a program to run in place of `nvidia-smi` (it gets `--query-gpu=name,driver_version --format=csv,noheader` and prints `<name>, <driver>` per card), or `off` for no such program, so the card check finds no GPU. |
| `KINETIC_VOICE_HELPER` | A whole command line run with `/bin/sh` (Windows: `cmd.exe /d /s /c`) in place of the helper; no Python download, and the helper starts for any request. |

The Windows exe reads the same variables (`windows/voice.go`,
`voiceSettingsFrom`).

The driver's `host` request with `voice: true` gives its bridge a
VoiceEngine set up from the driver's environment (`launchWebKit({ env })`,
`page.installHost(kind, display, { voice: true })`). The `machost`
scenario file runs it on WebKit against a local server, a fake Python
archive whose `python3` runs the repo's `.venv` Python, and the helper's
fake engine (docs/verify-player.md).
