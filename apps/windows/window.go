package main

// The game window's mode, place and size: the first window's size, the
// memory of how the reader left it, and how the next launch starts.
// Platform-neutral (window_test.go); window_windows.go supplies the
// monitors and carries the plan out.
//
// The exe is per-monitor DPI aware (its manifest, tools/windows_resources.py),
// so every place and size here is in the monitor's physical pixels. The
// first graphic's pixel size counts as CSS pixels, as the macOS app counts
// it as points: at 150% it covers 1.5 times as many physical pixels.

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
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

// windowBounds is a window's outer place and size in screen coordinates,
// as GetWindowRect gives it and the memory file keeps it.
type windowBounds struct {
	Left   int `json:"left"`
	Top    int `json:"top"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// monitor is one display: its whole area, its work area (less the
// taskbar) and its DPI.
type monitor struct {
	Area, Work rect
	DPI        int
}

// baseDPI is 100% scaling.
const baseDPI = 96

// scale is the monitor's scaling, 1 at 96 DPI.
func (m monitor) scale() float64 {
	if m.DPI <= 0 {
		return 1
	}

	return float64(m.DPI) / baseDPI
}

// fallbackMonitor stands in when Windows lists no monitor: a small
// laptop's, at 100%.
var fallbackMonitor = monitor{Area: rect{W: 1366, H: 768}, Work: rect{W: 1366, H: 728}, DPI: baseDPI}

// defaultContent is the first window's content without a size in the settings: 16:9.
var defaultContent = size{1280, 720}

// The smallest remembered window worth reopening, and how much of it must
// be in a monitor's work area, in physical pixels.
const (
	minRememberedW = 200
	minRememberedH = 150
	minOnScreen    = 100
)

// firstContent is the first window's content size in CSS pixels: the
// first graphic's from the game's settings, else 16:9.
func firstContent() size {
	if w := settings.WindowSize; w != nil && w.Width >= 1 && w.Height >= 1 {
		return size{w.Width, w.Height}
	}

	return defaultContent
}

// firstBounds is the first window on a monitor at scale: content (CSS
// pixels) at that scale, scaled down (never up) to fit the work area with
// a margin, plus the window's frame (physical pixels), centred in the work
// area. The macOS app fits its first window the same way
// (apps/macos/app/main.swift, firstFrame).
func firstBounds(work rect, content, frame size, scale float64) windowBounds {
	if content.W < 1 || content.H < 1 {
		content = defaultContent
	}

	if scale <= 0 {
		scale = 1
	}

	cw, ch := float64(content.W)*scale, float64(content.H)*scale
	margin := math.Max(24*scale, float64(min(work.W, work.H))*0.04)
	fit := math.Min(1, math.Min(
		(float64(work.W)-2*margin-float64(frame.W))/cw,
		(float64(work.H)-2*margin-float64(frame.H))/ch))
	w := max(1, int(math.Floor(cw*fit))) + frame.W
	h := max(1, int(math.Floor(ch*fit))) + frame.H

	return windowBounds{
		Left:   work.Left + int(math.Round(float64(work.W-w)/2)),
		Top:    work.Top + int(math.Round(float64(work.H-h)/2)),
		Width:  w,
		Height: h,
	}
}

// overlap is how much of b lies in r, across and down (0 when apart).
func overlap(b windowBounds, r rect) (int, int) {
	w := min(b.Left+b.Width, r.Left+r.W) - max(b.Left, r.Left)
	h := min(b.Top+b.Height, r.Top+r.H) - max(b.Top, r.Top)

	return max(0, w), max(0, h)
}

// usableOn reports whether remembered bounds are worth reopening on m: big
// enough, and enough of them in its work area.
func (b windowBounds) usableOn(m monitor) bool {
	if b.Width < minRememberedW || b.Height < minRememberedH {
		return false
	}

	w, h := overlap(b, m.Work)

	return w >= minOnScreen && h >= minOnScreen
}

// monitorFor is the monitor remembered bounds reopen on: of those they are
// usable on, the one holding most of them. False when they are on none, as
// when their monitor is no longer connected.
func monitorFor(b windowBounds, monitors []monitor) (int, bool) {
	best, bestArea := -1, 0

	for i, m := range monitors {
		if !b.usableOn(m) {
			continue
		}

		if w, h := overlap(b, m.Work); w*h > bestArea {
			best, bestArea = i, w*h
		}
	}

	return best, best >= 0
}

// windowedOn is the window's place and size on m when it leaves a
// fullscreen it started in: the remembered bounds while they are on m,
// else the first window for m (frame is m's window frame).
func windowedOn(m monitor, remembered *windowBounds, content, frame size) windowBounds {
	if remembered != nil && remembered.usableOn(m) {
		return *remembered
	}

	return firstBounds(m.Work, content, frame, m.scale())
}

// memoryFile holds how the reader left the game window, in the game's
// data folder.
const memoryFile = "kinetic-window.json"

// windowMemory is how the reader left the game window: its mode, its place
// and size the last time it was a plain window, and whether it was
// maximized then.
type windowMemory struct {
	Display   string        `json:"display,omitempty"`
	Bounds    *windowBounds `json:"bounds,omitempty"`
	Maximized bool          `json:"maximized,omitempty"`
}

// memoryPath is the memory file in the data folder dir.
func memoryPath(dir string) string {
	return filepath.Join(dir, memoryFile)
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
// one), making its folder when WebView2 has not yet.
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

// Window style bits (WinUser.h): a framed, resizable window
// (WS_OVERLAPPEDWINDOW), a frameless one (WS_POPUP), and children kept out
// of the parent's painting (WS_CLIPCHILDREN, so the black background never
// paints over the web view).
const (
	wsOverlappedWindow = 0x00CF0000
	wsPopup            = 0x80000000
	wsClipChildren     = 0x02000000
)

// styleFor is a window style changed for a display mode: frameless for
// fullscreen, framed for a window, every other bit kept. A frameless
// window is WS_POPUP, since Windows gives a top-level window without it a
// title bar when it is created.
func styleFor(display string, style uint32) uint32 {
	if display == displayFullscreen {
		return style&^wsOverlappedWindow | wsPopup
	}

	return style&^wsPopup | wsOverlappedWindow
}

// start is how the game window opens.
type start struct {
	// Fullscreen opens it frameless over Monitor's whole area; otherwise
	// it is a window at Normal.
	Fullscreen bool
	// Monitor is the display it opens on.
	Monitor monitor
	// Normal is its place and size as a window: where it opens in window
	// mode, and where it goes when it leaves fullscreen.
	Normal windowBounds
	// Maximized opens the window maximized (window mode only).
	Maximized bool
	// First says Normal is the first window's.
	First bool
}

// planStart opens the window the way the reader left it: fullscreen
// unless they left a window, on the monitor the remembered window is on
// while it is still connected (else the primary), at the remembered place
// and size there, else as the first window. frame gives a window's frame
// at a DPI.
func planStart(m windowMemory, monitors []monitor, primary int, content size, frame func(dpi int) size) start {
	mon := fallbackMonitor
	if primary >= 0 && primary < len(monitors) {
		mon = monitors[primary]
	}

	s := start{Fullscreen: m.Display != displayWindow, Monitor: mon, First: true}

	if m.Bounds != nil {
		if i, ok := monitorFor(*m.Bounds, monitors); ok {
			s.Monitor, s.Normal, s.First = monitors[i], *m.Bounds, false
			s.Maximized = m.Maximized && !s.Fullscreen
		}
	}

	if s.First {
		s.Normal = firstBounds(s.Monitor.Work, content, frame(s.Monitor.DPI), s.Monitor.scale())
	}

	return s
}
