package main

// Finding the installed Evergreen WebView2 Runtime without Microsoft's
// WebView2Loader.dll. Platform-neutral (runtime_test.go);
// registry_windows.go reads the registry.
//
// Sources:
//   - Microsoft's "Distribute your app and the WebView2 Runtime" (learn.
//     microsoft.com/microsoft-edge/webview2/concepts/distribution, read
//     2026-11-09), "Detect if a WebView2 Runtime is already installed":
//     the runtime's EdgeUpdate client id, and its version as `pv` under
//     HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{id} (per
//     machine) and HKCU\Software\Microsoft\EdgeUpdate\Clients\{id} (per
//     user); absent, empty or 0.0.0.0 means not installed.
//   - jchv/OpenWebView2Loader (ISC licence, commit fb3a168, 2022-08-25), a
//     reimplementation of WebView2Loader, Source/WebView2Loader.cpp, and
//     its Go port in wailsapp/go-webview2's webviewloader (ISC licence):
//     the loader reads the `EBWebView` value of
//     Software\Microsoft\EdgeUpdate\ClientState\{id}, HKLM then HKCU, with
//     KEY_WOW64_32KEY, as the runtime's version folder (its last part is
//     the version, at least 86.0.616.0), loads
//     <folder>\EBWebView\x64\EmbeddedBrowserWebView.dll, and creates the
//     environment with its CreateWebViewEnvironmentWithOptionsInternal
//     export (webview_windows.go). No code is copied from either.

import (
	"strconv"
	"strings"
)

// runtimeClientID is the Evergreen WebView2 Runtime's EdgeUpdate client id.
const runtimeClientID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

// The runtime's EdgeUpdate keys, under HKLM or HKCU.
const (
	runtimeStateKey   = `Software\Microsoft\EdgeUpdate\ClientState\` + runtimeClientID
	runtimeClientsKey = `Software\Microsoft\EdgeUpdate\Clients\` + runtimeClientID
)

// minimumRuntime is the oldest runtime the loader accepts.
var minimumRuntime = [4]int{86, 0, 616, 0}

// runtimeReading is what one registry view holds for the runtime.
type runtimeReading struct {
	// View names the view for the log.
	View string
	// PerUser says the view is HKCU (a per-user install).
	PerUser bool
	// Folder is ClientState's EBWebView: the runtime's version folder.
	Folder string
	// Version is Clients' pv; Location its location value, read when
	// present (Microsoft's docs do not describe it).
	Version, Location string
}

// runtimeCandidate is one place the runtime may be.
type runtimeCandidate struct {
	// Folder is the runtime's version folder; Version its version.
	Folder, Version string
	// From says where the candidate came from, for the log.
	From string
}

// parseVersion reads a four-part version, "120.0.2210.91".
func parseVersion(text string) ([4]int, bool) {
	var v [4]int

	parts := strings.Split(strings.TrimSpace(text), ".")
	if len(parts) != len(v) {
		return v, false
	}

	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return v, false
		}

		v[i] = n
	}

	return v, true
}

// supportedVersion reports whether text is a version at least
// minimumRuntime (0.0.0.0, Microsoft's "not installed", is not).
func supportedVersion(text string) bool {
	v, ok := parseVersion(text)
	if !ok {
		return false
	}

	for i := range v {
		if v[i] != minimumRuntime[i] {
			return v[i] > minimumRuntime[i]
		}
	}

	return true
}

// lastPart is the last part of a Windows path.
func lastPart(path string) string {
	path = strings.TrimRight(path, `\/`)

	return path[strings.LastIndexAny(path, `\/`)+1:]
}

// runtimeCandidates lists where the runtime may be, best first: for each
// view in turn, the folder ClientState names (what the official loader
// reads), then pv's folder under Clients' location, then under the
// installer's usual folder for that view (machine-wide in Program Files
// (x86), per user in LOCALAPPDATA). Versions older than minimumRuntime are
// left out.
func runtimeCandidates(readings []runtimeReading, getenv func(string) string) []runtimeCandidate {
	var out []runtimeCandidate

	add := func(folder, version, from string) {
		if folder != "" && supportedVersion(version) {
			out = append(out, runtimeCandidate{Folder: folder, Version: version, From: from})
		}
	}

	for _, r := range readings {
		if r.Folder != "" {
			add(strings.TrimRight(r.Folder, `\/`), lastPart(r.Folder), r.View+` ClientState\EBWebView`)
		}

		if r.Version == "" {
			continue
		}

		if r.Location != "" {
			add(winJoin(r.Location, r.Version), r.Version, r.View+` Clients\location+pv`)
		}

		roots := []string{"ProgramFiles(x86)", "ProgramFiles"}
		if r.PerUser {
			roots = []string{"LOCALAPPDATA"}
		}

		for _, variable := range roots {
			if root := getenv(variable); root != "" {
				add(winJoin(root, "Microsoft", "EdgeWebView", "Application", r.Version), r.Version,
					r.View+` Clients\pv in %`+variable+`%`)
			}
		}
	}

	return out
}

// runtimeDLL is the runtime's x64 client DLL in its version folder.
func runtimeDLL(folder string) string {
	return winJoin(folder, "EBWebView", "x64", "EmbeddedBrowserWebView.dll")
}

// pickRuntime is the first candidate whose client DLL exists.
func pickRuntime(candidates []runtimeCandidate, exists func(path string) bool) (runtimeCandidate, bool) {
	for _, c := range candidates {
		if exists(runtimeDLL(c.Folder)) {
			return c, true
		}
	}

	return runtimeCandidate{}, false
}
