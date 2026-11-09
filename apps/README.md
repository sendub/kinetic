# Game apps

`macos/` holds the macOS app (`app/`, Swift over the system WebKit) and the
scenario suite's WebKit driver (`driver/`), which share
`macos/WebViewSetup.swift`. `windows/` holds the Windows exe (Go, Microsoft
Edge). `tools/build_apps.py` builds them into a game folder (CREATE.md,
"Building the apps").

## The page-to-host protocol

One protocol serves both apps (docs/plan.md Phase 43 item 9). The page side
is `player/src/render/host.ts`; the macOS side is `KineticHostBridge` in
`macos/WebViewSetup.swift`.

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
  `KineticWindowSize` on macOS), scaled down to fit the screen; a size the
  reader sets is kept.
- With a host present the page never asks for element fullscreen. Without
  one (a browser tab) the page keeps a Display setting with its other
  settings and uses the Fullscreen API.

On macOS a user script at document start defines the object, `send` posts
to the `kineticHost` script message handler, and the app reports each
change through `setDisplay`, which also swaps the user script so a reload
starts with the mode in force. The WebKit driver installs the same bridge
with a recording host, so the scenarios test the page against the real
Swift side (docs/verify-player.md, "WebKit").
