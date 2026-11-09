package main

// The page side of the exe: the host object the page gets (the
// page-to-host protocol, apps/README.md), the messages it sends, which
// documents may send them, the keys the exe keeps for itself, and the
// names downloads are saved under. Platform-neutral (host_test.go);
// webview_windows.go wires them to WebView2.

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const (
	// hostKind is the protocol's kind for this host.
	hostKind = "windows-app"
	// hostSetter is where the host script keeps its display setter (not
	// enumerable), as the macOS bridge does (apps/macos/WebViewSetup.swift).
	hostSetter = "__kineticHostSetDisplay"
)

// jsString is text as a JavaScript string literal.
func jsString(text string) string {
	data, _ := json.Marshal(text)

	return string(data)
}

// hostScript is the script WebView2 runs as each document is created. In
// the game's top document it defines window.kineticHost (frozen, and not
// enumerable) in display, whose send posts the message to the exe, and
// fires kinetic-host. In a document that already has the object (two
// creation scripts overlap while the exe swaps them) it only sets display,
// firing the event when display changes, so the later script wins.
func hostScript(display string) string {
	return `(() => {
  if (window !== window.top || !window.chrome || !window.chrome.webview) return;
  const mode = ` + jsString(display) + `;
  if (window.kineticHost) {
    if (typeof window.` + hostSetter + ` === "function") window.` + hostSetter + `(mode);
    return;
  }
  let display = mode;
  const host = Object.freeze({
    kind: ` + jsString(hostKind) + `,
    get display() { return display; },
    send(message) { window.chrome.webview.postMessage(message); },
  });
  Object.defineProperty(window, "kineticHost", { value: host });
  Object.defineProperty(window, "` + hostSetter + `", {
    value(next) {
      if (next === display) return;
      display = next;
      window.dispatchEvent(new Event("kinetic-host"));
    },
  });
  window.dispatchEvent(new Event("kinetic-host"));
})();`
}

// setterScript tells the page in front a new display, as the macOS bridge
// does.
func setterScript(display string) string {
	return "window." + hostSetter + " && window." + hostSetter + "(" + jsString(display) + ");"
}

// hostMessage is a message the page sent: {type: "quit"}, or {type:
// "display", mode}.
type hostMessage struct {
	Type string `json:"type"`
	Mode string `json:"mode"`
}

// parseMessage reads a page message as WebView2 hands it over (the posted
// object as JSON); false for anything outside the protocol.
func parseMessage(text string) (hostMessage, bool) {
	var m hostMessage
	if json.Unmarshal([]byte(text), &m) != nil {
		return hostMessage{}, false
	}

	switch {
	case m.Type == "quit":
		return hostMessage{Type: "quit"}, true
	case m.Type == "display" && (m.Mode == displayFullscreen || m.Mode == displayWindow):
		return m, true
	default:
		return hostMessage{}, false
	}
}

// fromGame reports whether source, the URI of the document that sent a
// message, is the game's page at pageURL, any query or fragment aside.
// Both are file URLs; they are compared by host and unescaped path,
// ignoring case as Windows does, since the engine may write either one
// differently (drive letter case, which characters it escapes).
func fromGame(source, pageURL string) bool {
	got, errGot := url.Parse(source)
	want, errWant := url.Parse(pageURL)

	if errGot != nil || errWant != nil || got.Scheme != "file" || want.Scheme != "file" {
		return false
	}

	host := func(u *url.URL) string {
		if strings.EqualFold(u.Host, "localhost") {
			return ""
		}

		return u.Host
	}

	return strings.EqualFold(host(got), host(want)) && got.Path != "" && strings.EqualFold(got.Path, want.Path)
}

// keyAction is what the exe does with a key the web view offers it.
type keyAction int

const (
	// keyPass leaves the key to the page.
	keyPass keyAction = iota
	// keySwallow keeps the key from the page and does nothing (a held
	// reload or switch key's repeats).
	keySwallow
	// keyReload reloads the page.
	keyReload
	// keyToggle switches between fullscreen and a window.
	keyToggle
)

// Win32 virtual key codes and the web view's key event kind for a plain
// key press (COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN).
const (
	vkR     = 0x52
	vkF5    = 0x74
	vkF11   = 0x7A
	keyDown = 0

	// repeatBit is WM_KEYDOWN's lParam bit 30, set when the key was
	// already down: an auto-repeat.
	repeatBit = 1 << 30
)

// acceleratorAction decides a key event the web view's
// AcceleratorKeyPressed offers: F11 switches the mode, F5 and Ctrl+R
// reload (their repeats are kept from the page and do nothing), and every
// other key, Esc included, is the page's. Turning the browser's own
// accelerator keys off disables its F5 and Ctrl+R, so the exe does them.
func acceleratorAction(kind, virtualKey uint32, lParam int32, ctrl, alt bool) keyAction {
	if kind != keyDown || alt {
		return keyPass
	}

	var act keyAction

	switch {
	case virtualKey == vkF11:
		act = keyToggle
	case virtualKey == vkF5, virtualKey == vkR && ctrl:
		act = keyReload
	default:
		return keyPass
	}

	if lParam&repeatBit != 0 {
		return keySwallow
	}

	return act
}

// fallbackDownload names a download that comes with no name.
const fallbackDownload = "download"

// chromiumTaken is the " (N)" Chromium adds to a name already taken in its
// own download folder.
var chromiumTaken = regexp.MustCompile(`^(.+) \(\d+\)$`)

// splitName splits a file name into stem and extension (".json"); a name
// that starts with its only dot has no extension.
func splitName(name string) (string, string) {
	if dot := strings.LastIndex(name, "."); dot > 0 {
		return name[:dot], name[dot:]
	}

	return name, ""
}

// downloadName is the name a download is saved under: the file name of
// the path WebView2 suggests, less any " (N)" Chromium added.
func downloadName(suggested string) string {
	name := suggested[strings.LastIndexAny(suggested, `\/`)+1:]
	stem, ext := splitName(name)

	if m := chromiumTaken.FindStringSubmatch(stem); m != nil {
		stem = m[1]
	}

	if strings.TrimSpace(stem+ext) == "" {
		return fallbackDownload
	}

	return stem + ext
}

// maxCopies bounds the numbered names freeName tries.
const maxCopies = 9999

// freeName is where a download named name goes in dir without replacing
// anything there: dir\name, else dir\stem (2).ext, dir\stem (3).ext, and so
// on, the first that taken does not report (the last tried, past
// maxCopies).
func freeName(dir, name string, taken func(path string) bool) string {
	stem, ext := splitName(name)
	path := winJoin(dir, name)

	for n := 2; n <= maxCopies && taken(path); n++ {
		path = winJoin(dir, fmt.Sprintf("%s (%d)%s", stem, n, ext))
	}

	return path
}

// windowTitle is the window's title for the page's: the page's, unless it
// has none yet (WebView2 then reports the page's URL), else the game's.
func windowTitle(page, game string) string {
	if strings.TrimSpace(page) == "" || strings.HasPrefix(strings.ToLower(page), "file:") {
		return game
	}

	return page
}

// hresult formats a COM result for the log.
func hresult(hr int32) string {
	return fmt.Sprintf("0x%08X", uint32(hr))
}
