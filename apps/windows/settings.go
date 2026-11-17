package main

// The game's settings (docs/plan.md Phase 57 item 10). The exe is built
// once per Kinetic release with none; `kinetic apps --windows` copies it
// into a game folder and writes the game's settings into the copy as one
// RT_RCDATA resource, settingsResourceID, a small UTF-8 JSON object:
//
//	{"kineticVersion": "1.12.0", "storyId": "rainy-day",
//	 "title": "Rainy Day", "windowSize": {"width": 1920, "height": 1080}}
//
// (windowSize left out for a game with no readable picture). The exe reads
// it once at start (settings_windows.go: the resource is already mapped
// with the image, so it costs a lookup and a small JSON parse) and holds
// it in `settings`. A missing or unreadable resource, or a storyId that
// breaks the manifest's rule, leaves every field empty, which main reports
// as an exe made without its game's details.
//
// `<exe> --self-check FILE` writes the settings it read to FILE as JSON
// and exits without a window (a GUI program has no console to print to);
// tools and tests read the file. Platform-neutral (settings_test.go).

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
)

// settingsResourceID is the settings resource's RT_RCDATA id (1 and 2 are
// the license texts).
const settingsResourceID = 3

// selfCheckFlag asks the exe to write its settings and exit.
const selfCheckFlag = "--self-check"

// storyIDRule is the manifest's storyId pattern (docs/content-schema.json):
// the id names folders, a window class and a mutex.
var storyIDRule = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

// windowSize is the game's first graphic's pixel size, for the first
// window.
type windowSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// hostSettings is what `kinetic apps` writes for the game.
type hostSettings struct {
	StoryID        string      `json:"storyId"`
	Title          string      `json:"title"`
	WindowSize     *windowSize `json:"windowSize,omitempty"`
	KineticVersion string      `json:"kineticVersion"`
}

// settings is the game's settings, read once at start (main).
var settings hostSettings

// parseSettings reads the settings resource; empty settings when it is
// missing, not JSON, or its storyId breaks the rule. A window size below
// 1x1 is dropped.
func parseSettings(data []byte) hostSettings {
	var s hostSettings
	if len(data) == 0 || json.Unmarshal(data, &s) != nil || !storyIDRule.MatchString(s.StoryID) {
		return hostSettings{}
	}

	if s.WindowSize != nil && (s.WindowSize.Width < 1 || s.WindowSize.Height < 1) {
		s.WindowSize = nil
	}

	return s
}

// selfCheckReport is what --self-check writes: the settings as read, the
// window size null when there is none. The Mac app writes the same keys
// (apps/macos/app/HostSettings.swift), with its bundle id besides.
type selfCheckReport struct {
	Host           string      `json:"host"`
	StoryID        string      `json:"storyId"`
	Title          string      `json:"title"`
	WindowSize     *windowSize `json:"windowSize"`
	KineticVersion string      `json:"kineticVersion"`
}

// selfCheckPath is the FILE after --self-check in the exe's arguments,
// and whether the flag is there at all ("" when FILE is missing).
func selfCheckPath(args []string) (string, bool) {
	for i, arg := range args {
		if arg == selfCheckFlag {
			if i+1 < len(args) {
				return args[i+1], true
			}

			return "", true
		}

		if value, ok := strings.CutPrefix(arg, selfCheckFlag+"="); ok {
			return value, true
		}
	}

	return "", false
}

// selfCheck writes s to path as the --self-check report; the exit code:
// 0 written, 1 not written, 2 no FILE given.
func selfCheck(path string, s hostSettings) int {
	if path == "" {
		return 2
	}

	data, err := json.Marshal(selfCheckReport{
		Host: "windows", StoryID: s.StoryID, Title: s.Title,
		WindowSize: s.WindowSize, KineticVersion: s.KineticVersion,
	})
	if err != nil {
		return 1
	}

	if os.WriteFile(path, append(data, '\n'), 0o644) != nil {
		return 1
	}

	return 0
}
