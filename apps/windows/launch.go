// Kinetic's Windows app. tools/build_apps.py --windows builds this package
// into <title>.exe inside a game folder. Double-clicked, it opens the
// folder's index.html in a Microsoft Edge app window (its own window, no
// tabs or toolbar), under an Edge profile used only by this game,
// fullscreen or as the window the reader left. Edge ships with Windows 10
// and 11; Chrome stands in when Edge is missing, then the default browser.
// The exe then stays running, with no window of its own, and steers the
// game window over the browser's DevTools connection for the page's
// Fullscreen | Window switch and Exit (controller.go), until the browser
// closes.
//
// This file holds the steps that are plain string work, so they build and
// test on any OS (launch_test.go). main_windows.go runs them on Windows.
package main

import (
	"fmt"
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

// fallbackTitle captions a message box when the title is missing.
const fallbackTitle = "Kinetic"

// gameTitle is the game's title, for message box captions (which end at
// a NUL).
func gameTitle() string {
	title, err := url.PathUnescape(titleEscaped)
	if err != nil || strings.TrimSpace(title) == "" || strings.ContainsRune(title, 0) {
		return fallbackTitle
	}

	return title
}

// fileURL turns a Windows path into the file:// URL Edge's --app wants:
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

// The browsers tried, in order, each under every root in browserRoots.
var browserExes = [][]string{
	{"Microsoft", "Edge", "Application", "msedge.exe"},
	{"Google", "Chrome", "Application", "chrome.exe"},
}

// The environment variables naming where browsers install: machine-wide
// (32-bit and 64-bit Program Files), then per user.
var browserRoots = []string{"ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"}

// browserPaths lists where Edge installs, then where Chrome does, from the
// environment values getenv returns; unset roots are skipped.
func browserPaths(getenv func(string) string) []string {
	var out []string

	for _, exe := range browserExes {
		for _, variable := range browserRoots {
			if root := getenv(variable); root != "" {
				out = append(out, winJoin(root, exe...))
			}
		}
	}

	return out
}

// profileDir is the browser profile only this game uses,
// %LOCALAPPDATA%\Kinetic\Browser\<storyId>, or "" without LOCALAPPDATA.
func profileDir(getenv func(string) string, story string) string {
	root := getenv("LOCALAPPDATA")
	if root == "" || story == "" {
		return ""
	}

	return winJoin(root, "Kinetic", "Browser", story)
}

// browserArgs opens pageURL as an app window (no tabs or toolbar) under
// profile, fullscreen or as a window at its place and size (so a window
// never flashes fullscreen first), with none of a new profile's prompts.
// --remote-debugging-port=0 opens the DevTools connection the exe steers
// the window over, on a free loopback port the browser writes to
// DevToolsActivePort in the profile; Edge and Chrome allow it with a
// profile of the exe's own (--user-data-dir).
func browserArgs(profile, pageURL string, s start) []string {
	args := []string{"--user-data-dir=" + profile, "--app=" + pageURL}
	if s.Fullscreen {
		args = append(args, "--start-fullscreen")
	} else {
		args = append(args,
			fmt.Sprintf("--window-size=%d,%d", s.Bounds.Width, s.Bounds.Height),
			fmt.Sprintf("--window-position=%d,%d", s.Bounds.Left, s.Bounds.Top))
	}

	return append(args,
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-crash-restore-bubble",
	)
}
