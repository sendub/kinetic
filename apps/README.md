# Game apps

`macos/` holds the macOS app (`app/`, Swift over the system WebKit) and the
scenario suite's WebKit driver (`driver/`), which share
`macos/WebViewSetup.swift`. `windows/` holds the Windows exe (Go's
standard library over WebView2). `tools/build_apps.py` builds them into a
game folder (CREATE.md, "Building the apps").

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
message and sender checks, the keys, download names and finding the
runtime. Running the exe on Windows is a manual check.
