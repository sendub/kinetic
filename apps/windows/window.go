package main

// The game window's mode, place and size: the first window's size, the
// memory of how the reader left it, and how the next launch starts.
// Platform-neutral (window_test.go); main_windows.go supplies the screen.
//
// Every size here is in Windows' logical pixels, which are Chrome's DIPs
// (device-independent pixels), the unit of --window-size,
// --window-position and the DevTools window bounds. The exe has no DPI
// manifest, so Windows hands it the work area and screen in those same
// logical (96-DPI) pixels, scaled from the display's real ones.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The two display modes, the protocol's words (apps/README.md).
const (
	displayFullscreen = "fullscreen"
	displayWindow     = "window"
)

// size is a width and height.
type size struct{ W, H int }

// rect is an area of the screen.
type rect struct{ Left, Top, W, H int }

// windowBounds is a window's outer place and size, as the DevTools window
// bounds and the memory file give them.
type windowBounds struct {
	Left   int `json:"left"`
	Top    int `json:"top"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Set by tools/build_apps.py with -ldflags -X: the game's first graphic's
// pixel size, "<width>x<height>", for the first window; empty when the game
// has no readable picture.
var firstWindowSize string

// defaultContent is the first window's content without a baked size: 16:9.
var defaultContent = size{1280, 720}

// estimatedFrame is what an Edge app window adds around its page before
// the page can be measured: Windows' invisible resize borders (8 on each
// side and below) and the title bar. The controller measures the real
// frame once the page is up and corrects the first window to it.
var estimatedFrame = size{16, 40}

// The smallest remembered window worth reopening, and how much of it must
// be on a screen.
const (
	minRememberedW = 200
	minRememberedH = 150
	minOnScreen    = 100
)

// parseSize reads "<width>x<height>" (both at least 1).
func parseSize(text string) (size, bool) {
	w, h, ok := strings.Cut(text, "x")
	if !ok {
		return size{}, false
	}

	width, errW := strconv.Atoi(w)
	height, errH := strconv.Atoi(h)

	if errW != nil || errH != nil || width < 1 || height < 1 {
		return size{}, false
	}

	return size{width, height}, true
}

// firstContent is the first window's content size: the baked first
// graphic's, else 16:9.
func firstContent() size {
	if s, ok := parseSize(firstWindowSize); ok {
		return s
	}

	return defaultContent
}

// firstBounds is the first window: content's size and shape scaled down
// (never up) to fit the work area with a margin, plus the window's frame,
// centred in the work area. The macOS app fits its first window the same
// way (apps/macos/app/main.swift, firstFrame).
func firstBounds(work rect, content, frame size) windowBounds {
	if content.W < 1 || content.H < 1 {
		content = defaultContent
	}

	margin := math.Max(24, float64(min(work.W, work.H))*0.04)
	scale := math.Min(1, math.Min(
		(float64(work.W)-2*margin-float64(frame.W))/float64(content.W),
		(float64(work.H)-2*margin-float64(frame.H))/float64(content.H)))
	w := max(1, int(math.Floor(float64(content.W)*scale))) + frame.W
	h := max(1, int(math.Floor(float64(content.H)*scale))) + frame.H

	return windowBounds{
		Left:   work.Left + int(math.Round(float64(work.W-w)/2)),
		Top:    work.Top + int(math.Round(float64(work.H-h)/2)),
		Width:  w,
		Height: h,
	}
}

// usable reports whether remembered bounds are worth reopening: big enough,
// and enough of them on the screen (the bounding box of every display).
func (b windowBounds) usable(screen rect) bool {
	if b.Width < minRememberedW || b.Height < minRememberedH {
		return false
	}

	overlapW := min(b.Left+b.Width, screen.Left+screen.W) - max(b.Left, screen.Left)
	overlapH := min(b.Top+b.Height, screen.Top+screen.H) - max(b.Top, screen.Top)

	return overlapW >= minOnScreen && overlapH >= minOnScreen
}

// memoryFile holds how the reader left the game window, in the game's
// browser profile folder.
const memoryFile = "kinetic-window.json"

// windowMemory is how the reader left the game window: its mode, and its
// place and size the last time it was a plain window.
type windowMemory struct {
	Display string        `json:"display,omitempty"`
	Bounds  *windowBounds `json:"bounds,omitempty"`
}

// memoryPath is the memory file in profile.
func memoryPath(profile string) string {
	return filepath.Join(profile, memoryFile)
}

// loadMemory reads the memory file; a missing or unreadable one is no
// memory, which starts fullscreen.
func loadMemory(path string) windowMemory {
	var m windowMemory

	data, err := os.ReadFile(path)
	if err != nil || json.Unmarshal(data, &m) != nil {
		m = windowMemory{}
	}

	if m.Display != displayWindow {
		m.Display = displayFullscreen
	}

	return m
}

// saveMemory writes the memory file whole (a new file renamed over the old
// one), making its folder when the browser has not yet.
func saveMemory(path string, m windowMemory) error {
	data, err := json.Marshal(m)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	partial := path + ".partial"
	if err := os.WriteFile(partial, data, 0o644); err != nil {
		return err
	}

	return os.Rename(partial, path)
}

// start is how the browser opens the game window.
type start struct {
	// Fullscreen opens it fullscreen; otherwise it is a window at Bounds.
	Fullscreen bool
	Bounds     windowBounds
	// First says Bounds are the first window's, from estimatedFrame.
	First bool
}

// planStart opens the window the way the reader left it: fullscreen
// unless they left a window, then at its remembered place and size while
// those are still on screen, else the first window.
func planStart(m windowMemory, screen rect, first func(frame size) windowBounds) start {
	if m.Display != displayWindow {
		return start{Fullscreen: true}
	}

	if m.Bounds != nil && m.Bounds.usable(screen) {
		return start{Bounds: *m.Bounds}
	}

	return start{Bounds: first(estimatedFrame), First: true}
}
