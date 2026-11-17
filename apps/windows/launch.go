// Kinetic's Windows app. Each release builds this package once
// (kinetic_extract/app_hosts.py), and `kinetic apps --windows` copies it
// into a game folder as <title>.exe with the game's settings
// (settings.go). Double-clicked, it opens a window
// of its own and shows the folder's index.html in it through WebView2, the
// Edge engine Windows provides to apps: fullscreen (the window without its
// frame, covering its monitor) or as the window the reader left. It gives
// the page the host object of the page-to-host protocol (apps/README.md)
// for the Esc screen's Fullscreen | Window switch and Exit.
//
// The decisions live in platform-neutral files that build and test on any
// OS: this file (names and paths), window.go (the window's place, size and
// memory), host.go (the host script, the page's messages, keys and
// downloads), runtime.go (finding the WebView2 Runtime), settings.go (the
// game's settings) and log.go. The
// *_windows.go files carry them out on Windows.
package main

import (
	"net/url"
	"strings"
)

const (
	// fallbackTitle captions the window and message boxes when the title
	// is missing.
	fallbackTitle = "Kinetic"
	pageName      = "index.html"
	// logFile is the exe's log, in the game's data folder.
	logFile = "kinetic-host.log"
)

// gameTitle is the game's title from its settings, for the window and
// message box captions (which end at a NUL).
func gameTitle() string {
	title := settings.Title
	if strings.TrimSpace(title) == "" || strings.ContainsRune(title, 0) {
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

// envVar is one environment variable to set.
type envVar struct{ Name, Value string }

const (
	// argumentsVariable holds extra Chromium switches; WebView2 reads it
	// when the environment is created, and appends it to the options'
	// AdditionalBrowserArguments (Microsoft's
	// CreateCoreWebView2EnvironmentWithOptions reference). The runtime DLL
	// reads it, not the loader, which this exe does without: no
	// WebView2Loader reimplementation handles it.
	argumentsVariable = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
	// autoplayFlag lets sound start with no click, as the Mac app's
	// mediaTypesRequiringUserActionForPlayback = [] does (docs/plan.md
	// Phase 47). Microsoft lists it, and discourages browser flags in
	// shipped apps; options' AdditionalBrowserArguments would need an
	// ICoreWebView2EnvironmentOptions COM object made in Go for one
	// string, where this exe already passes the background colour through
	// a variable.
	autoplayFlag = "--autoplay-policy=no-user-gesture-required"
)

// webViewEnvironment is what the exe sets before it creates the WebView2
// environment, which reads both: a black background from the first frame
// (Microsoft notes that the API's colour can still flash white first, and
// the variable does not), and sound with no click. Arguments the reader
// set already are kept, ours after them; their own --autoplay-policy
// stands.
func webViewEnvironment(getenv func(string) string) []envVar {
	args := strings.Join(strings.Fields(getenv(argumentsVariable)), " ")
	if !strings.Contains(args, "--autoplay-policy=") {
		args = strings.TrimSpace(args + " " + autoplayFlag)
	}

	return []envVar{
		{"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF000000"},
		{argumentsVariable, args},
	}
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
