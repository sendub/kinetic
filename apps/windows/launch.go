// Kinetic's Windows app. tools/build_apps.py --windows builds this package
// into <title>.exe inside a game folder. Double-clicked, it opens a window
// of its own and shows the folder's index.html in it through WebView2, the
// Edge engine Windows provides to apps: fullscreen (the window without its
// frame, covering its monitor) or as the window the reader left. It gives
// the page the host object of the page-to-host protocol (apps/README.md)
// for the Esc screen's Fullscreen | Window switch and Exit.
//
// The decisions live in platform-neutral files that build and test on any
// OS: this file (names and paths), window.go (the window's place, size and
// memory), host.go (the host script, the page's messages, keys and
// downloads), runtime.go (finding the WebView2 Runtime) and log.go. The
// *_windows.go files carry them out on Windows.
package main

import (
	"net/url"
	"strings"
)

// Set by tools/build_apps.py with -ldflags -X: the manifest's storyId, and
// its title percent-encoded, because go build splits -ldflags at spaces
// and reads no escapes inside quotes.
var (
	storyID      string
	titleEscaped string
)

const (
	// fallbackTitle captions the window and message boxes when the title
	// is missing.
	fallbackTitle = "Kinetic"
	pageName      = "index.html"
	// logFile is the exe's log, in the game's data folder.
	logFile = "kinetic-host.log"
)

// gameTitle is the game's title, for the window and message box captions
// (which end at a NUL).
func gameTitle() string {
	title, err := url.PathUnescape(titleEscaped)
	if err != nil || strings.TrimSpace(title) == "" || strings.ContainsRune(title, 0) {
		return fallbackTitle
	}

	return title
}

// fileURL turns a Windows path into a file:// URL:
// C:\Games\My Game\index.html becomes file:///C:/Games/My%20Game/index.html,
// and \\server\share\x.html becomes file://server/share/x.html.
func fileURL(windowsPath string) string {
	p := strings.ReplaceAll(windowsPath, `\`, "/")
	if rest, ok := strings.CutPrefix(p, "//"); ok {
		host, path, _ := strings.Cut(rest, "/")

		return (&url.URL{Scheme: "file", Host: host, Path: "/" + path}).String()
	}

	return (&url.URL{Scheme: "file", Path: "/" + p}).String()
}

// winJoin joins Windows path parts with backslashes, whatever OS runs it.
func winJoin(root string, parts ...string) string {
	return strings.Join(append([]string{strings.TrimRight(root, `\/`)}, parts...), `\`)
}

// dataDir is the game's WebView2 user data folder,
// %LOCALAPPDATA%\Kinetic\WebView2\<storyId>, which also holds the window
// memory and the log; "" without LOCALAPPDATA or a story.
func dataDir(getenv func(string) string, story string) string {
	root := getenv("LOCALAPPDATA")
	if root == "" || story == "" {
		return ""
	}

	return winJoin(root, "Kinetic", "WebView2", story)
}

// windowClass is the game window's class name. A second launch finds the
// open game's window by it.
func windowClass(story string) string {
	return "KineticGame-" + story
}

// mutexName names the mutex the running game holds, in the reader's
// session, so a second launch knows the game is open.
func mutexName(story string) string {
	return `Local\KineticGame-` + story
}
