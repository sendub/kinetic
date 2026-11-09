# Game apps

`macos/` holds the macOS app (`app/`, Swift over the system WebKit) and the
scenario suite's WebKit driver (`driver/`), which share
`macos/WebViewSetup.swift`. `windows/` holds the Windows exe (Go, Microsoft
Edge). `tools/build_apps.py` builds them into a game folder (CREATE.md,
"Building the apps").

## The page-to-host protocol

One protocol serves both apps (docs/plan.md Phase 43 item 9). The page side
is `player/src/render/host.ts`; the macOS side is `KineticHostBridge` in
`macos/WebViewSetup.swift`; the Windows side is `windows/controller.go`.

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

On Windows the exe stays running, with no window of its own, while the
game is open, and steers its Edge window over Edge's DevTools connection:
a page cannot leave the fullscreen Edge started in.

- It starts Edge with `--remote-debugging-port=0`. Edge picks a free port
  on the loopback address (127.0.0.1) only, and writes it with the
  browser's WebSocket path to `DevToolsActivePort` in the game's profile
  folder; the exe deletes a stale one first. The port lives only as long
  as that Edge.
- It attaches to the game's page (`Target.attachToTarget`, flattened
  sessions), adds the binding `__kineticHostSend` (`Runtime.addBinding`)
  and a new-document script that defines the object (`send` calls the
  binding with the message as JSON), and runs the script once in the page
  already loaded. `Runtime.enable` keeps the binding across reloads and
  `Page.enable` runs the script in each new document.
- `quit` is `Browser.close`. `display` sets the window state with
  `Browser.setWindowBounds` (`fullscreen`, or `normal` first and the
  bounds after, which DevTools needs), then updates the page's `display`,
  fires the event and swaps the new-document script, so a reload starts in
  the mode in force.
- DevTools has no window-state event, so the exe reads
  `Browser.getWindowBounds` once a second and reports the reader's own
  switches (F11). A minimized window changes nothing; a maximized one is
  a window.
- It keeps the mode and the last plain window's bounds in
  `kinetic-window.json` in the profile folder, and starts Edge in that
  mode (`--start-fullscreen`, or `--window-size` and `--window-position`).
  The first window is the baked size fitted to the work area with a
  margin, centred. It is sized for an estimated window frame at launch,
  then the exe measures the real frame around the page and corrects it. A
  window that starts fullscreen gets its remembered or first bounds the
  first time it becomes a window.
- Sizes are logical (96-DPI) pixels, which are Chrome's DIPs: the exe has
  no DPI manifest, so Windows reports the work area to it in those units.
- The exe ends when Edge does (the connection closes), and closes Edge
  when the game's page goes, so the port goes with it. With no DevTools
  connection within 10 s (a policy can turn it off), the exe ends and the
  page plays with no host object, as in a browser tab.
- Each run logs what it did to `kinetic-host.log` in the profile folder,
  for a reader reporting a problem.

`windows/controller_test.go` tests the controller against headless Chrome
started with the exe's own arguments; running the exe on Windows is a
manual check.
