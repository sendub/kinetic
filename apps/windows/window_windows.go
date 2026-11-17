package main

// The game window: a Win32 window of the exe's own, black until the web
// view paints, with the build's icon. Fullscreen is the window without its
// frame covering its whole monitor, which WebView2 does not treat as
// fullscreen (so it shows no notice and leaves every key to the page).
// Switching follows the usual pattern: remember the placement
// (GetWindowPlacement), drop the frame and cover the monitor; then put the
// frame and the placement back (SetWindowPlacement), each with
// SWP_FRAMECHANGED.

import (
	"errors"
	"fmt"
	"syscall"
	"time"
	"unsafe"
)

// game is the running game: its window and its web view
// (webview_windows.go). Everything runs on the one UI thread.
type game struct {
	hwnd    syscall.Handle
	page    string
	pageURL string
	dir     string
	runtime runtimeCandidate
	content size

	memory  windowMemory
	display string
	// prev is the window's placement before it went fullscreen this run.
	prev       windowPlacement
	hasPrev    bool
	inSizeMove bool

	webView
	voiceBridge
	// fallback, once set, says why the game is leaving for the default
	// browser.
	fallback string
}

// theGame is the window wndProc serves.
var theGame *game

// wndProcCallback is the window procedure, made once.
var wndProcCallback = syscall.NewCallback(wndProc)

// The window's style bits beyond the frame, and GetWindowLongPtr's style
// index (GWL_STYLE).
const (
	gwlStyle   = -16
	baseStyle  = wsClipChildren
	hwndTop    = 0
	windowMove = swpNoZOrder | swpNoOwnerZOrder | swpFrameChanged
)

// createWindow registers the game's window class (its name holds the
// storyId, so a second launch can find the window) and opens the window as
// s plans: frameless over the monitor, or framed at its normal place,
// maximized if it was left so.
func (g *game) createWindow(s start) error {
	instance, _, _ := procGetModuleHandle.Call(0)
	class := utf16(windowClass(settings.StoryID))
	cursor, _, _ := procLoadCursor.Call(0, idcArrow)
	brush, _, _ := procGetStockObject.Call(blackBrush)
	icon := func(w, h uintptr) syscall.Handle {
		cx, _, _ := procGetSystemMetrics.Call(w)
		cy, _, _ := procGetSystemMetrics.Call(h)
		handle, _, _ := procLoadImage.Call(instance, iconResource, imageIcon, cx, cy, 0)

		return syscall.Handle(handle)
	}

	wc := wndClassEx{
		WndProc:    wndProcCallback,
		Instance:   syscall.Handle(instance),
		Icon:       icon(smCXIcon, smCYIcon),
		IconSm:     icon(smCXSmIcon, smCYSmIcon),
		Cursor:     syscall.Handle(cursor),
		Background: syscall.Handle(brush),
		ClassName:  class,
	}
	wc.Size = uint32(unsafe.Sizeof(wc))

	if atom, _, err := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&wc))); atom == 0 {
		return fmt.Errorf("RegisterClassExW: %w", err)
	}

	style, b := uint32(baseStyle|wsOverlappedWindow), s.Normal
	if s.Fullscreen {
		style = styleFor(displayFullscreen, style)
		b = windowBounds{Left: s.Monitor.Area.Left, Top: s.Monitor.Area.Top, Width: s.Monitor.Area.W, Height: s.Monitor.Area.H}
	}

	theGame = g
	hwnd, _, err := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(class)), uintptr(unsafe.Pointer(utf16(gameTitle()))),
		uintptr(style), uintptr(b.Left), uintptr(b.Top), uintptr(b.Width), uintptr(b.Height), 0, 0, instance, 0)
	if hwnd == 0 {
		return fmt.Errorf("CreateWindowExW: %w", err)
	}

	g.hwnd = syscall.Handle(hwnd)

	show := uintptr(swShow)
	if s.Maximized {
		show = swShowMaximized
	}

	_, _, _ = procShowWindow.Call(hwnd, show)

	return nil
}

// messageLoop runs the window's messages until it closes.
func messageLoop() {
	var m winMsg

	for {
		if r, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0); int32(r) <= 0 {
			return
		}

		_, _, _ = procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		_, _, _ = procDispatchMessage.Call(uintptr(unsafe.Pointer(&m)))
	}
}

// wndProc serves the game window. A panic is logged rather than ending
// the process from inside Windows.
func wndProc(hwnd syscall.Handle, message uint32, wParam, lParam uintptr) (result uintptr) {
	defer func() {
		if r := recover(); r != nil {
			logf("window message 0x%04X: %v", message, r)

			result = 0
		}
	}()

	if g := theGame; g != nil && g.hwnd != 0 && hwnd == g.hwnd {
		if handled := g.handle(message, wParam, lParam); handled {
			return 0
		}
	}

	result, _, _ = procDefWindowProc.Call(uintptr(hwnd), uintptr(message), wParam, lParam)

	return result
}

// handle acts on a window message; true when it is done with it.
func (g *game) handle(message uint32, wParam, lParam uintptr) bool {
	switch message {
	case wmSize:
		g.fitWebView(wParam != sizeMinimized)

		if !g.inSizeMove && wParam != sizeMinimized {
			g.noteWindow()
		}

		return true
	case wmMove:
		g.webViewMoved()

		if g.display == displayFullscreen && !g.inSizeMove {
			g.keepCovering()
		}
	case wmMoving:
		g.webViewMoved()
	case wmEnterSizeMove:
		g.inSizeMove = true
	case wmExitSizeMove:
		g.inSizeMove = false
		g.noteWindow()
	case wmSetFocus:
		g.focusWebView()

		return true
	case wmDpiChanged:
		g.dpiChanged(ptrAt[winRect](lParam))

		return true
	case wmDisplayChange:
		if g.display == displayFullscreen {
			g.coverMonitor()
		}
	case wmDestroy:
		g.closing()

		return true
	case wmAppToggle:
		if g.display == displayFullscreen {
			g.switchTo(displayWindow)
		} else {
			g.switchTo(displayFullscreen)
		}

		return true
	case wmAppDisplay:
		if wParam == 1 {
			g.switchTo(displayFullscreen)
		} else {
			g.switchTo(displayWindow)
		}

		return true
	case wmAppReload:
		g.reload()

		return true
	case wmAppRestart:
		g.restartWebView()

		return true
	case wmAppVoice:
		g.deliverVoice()

		return true
	}

	return false
}

// style is the window's style now.
func (g *game) style() uint32 {
	style, _, _ := procGetWindowLongPtr.Call(uintptr(g.hwnd), index(gwlStyle))

	return uint32(style)
}

// setStyle changes the window's style (a SetWindowPos with
// SWP_FRAMECHANGED must follow).
func (g *game) setStyle(style uint32) {
	_, _, _ = procSetWindowLongPtr.Call(uintptr(g.hwnd), index(gwlStyle), uintptr(style))
}

// index passes a negative GetWindowLongPtr index.
func index(i int32) uintptr {
	return uintptr(i)
}

// place moves and sizes the window.
func (g *game) place(insertAfter uintptr, b windowBounds, flags uintptr) {
	_, _, _ = procSetWindowPos.Call(uintptr(g.hwnd), insertAfter,
		uintptr(b.Left), uintptr(b.Top), uintptr(b.Width), uintptr(b.Height), flags)
}

// coverMonitor lays the frameless window over its monitor's whole area.
func (g *game) coverMonitor() {
	a := windowMonitor(g.hwnd).Area
	g.place(hwndTop, windowBounds{Left: a.Left, Top: a.Top, Width: a.W, Height: a.H}, swpNoOwnerZOrder|swpFrameChanged)
}

// keepCovering lays the frameless window over the monitor it was moved to
// (Win+Shift+arrow moves it without changing its size).
func (g *game) keepCovering() {
	var r winRect
	if ok, _, _ := procGetWindowRect.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(&r))); ok == 0 {
		return
	}

	if r.rect() != windowMonitor(g.hwnd).Area {
		g.coverMonitor()
	}
}

// switchTo puts the window in mode, then tells the page and remembers it.
func (g *game) switchTo(mode string) {
	if mode == g.display || g.hwnd == 0 {
		return
	}

	if mode == displayFullscreen {
		g.noteWindow()

		g.prev = windowPlacement{Length: uint32(unsafe.Sizeof(windowPlacement{}))}
		ok, _, _ := procGetWindowPlacement.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(&g.prev)))
		g.hasPrev = ok != 0
		g.display = mode
		g.setStyle(styleFor(mode, g.style()))
		g.coverMonitor()
	} else {
		// The mode changes first, so the moves below are not taken for a
		// frameless window that has to cover its monitor again.
		g.display = mode
		g.setStyle(styleFor(mode, g.style()))
		g.leaveFullscreen()
		g.noteWindow()
	}

	logf("display %s", mode)

	g.memory.Display = mode
	g.save()
	g.tellPage()
}

// leaveFullscreen puts the window back where it was before this run's
// fullscreen, or, for a window that started fullscreen, where the reader
// left it on this monitor, else the first window.
func (g *game) leaveFullscreen() {
	if g.hasPrev {
		_, _, _ = procSetWindowPlacement.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(&g.prev)))
		g.place(0, windowBounds{}, swpNoMove|swpNoSize|windowMove)

		return
	}

	m := windowMonitor(g.hwnd)
	b := windowedOn(m, g.memory.Bounds, g.content, windowFrame(m.DPI))
	// Read before placing: the move updates the memory.
	maximize := g.memory.Maximized && g.memory.Bounds != nil && *g.memory.Bounds == b
	g.place(0, b, windowMove)

	if maximize {
		_, _, _ = procShowWindow.Call(uintptr(g.hwnd), swShowMaximized)
	}
}

// noteWindow keeps a plain window's place and size, and whether it is
// maximized, in the memory file.
func (g *game) noteWindow() {
	if g.display != displayWindow || g.hwnd == 0 {
		return
	}

	if iconic, _, _ := procIsIconic.Call(uintptr(g.hwnd)); iconic != 0 {
		return
	}

	zoomed, _, _ := procIsZoomed.Call(uintptr(g.hwnd))
	changed := (zoomed != 0) != g.memory.Maximized
	g.memory.Maximized = zoomed != 0

	if zoomed == 0 {
		var r winRect
		if ok, _, _ := procGetWindowRect.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(&r))); ok != 0 {
			if b := r.bounds(); g.memory.Bounds == nil || *g.memory.Bounds != b {
				g.memory.Bounds, changed = &b, true
			}
		}
	}

	if changed {
		g.save()
	}
}

// save writes the memory file.
func (g *game) save() {
	if err := saveMemory(memoryPath(g.dir), g.memory); err != nil {
		logf("saving the window memory: %v", err)
	}
}

// dpiChanged follows a change of DPI (the window moved to another monitor,
// or the reader changed the scaling): a window takes the size Windows
// suggests, and the frameless one covers its monitor again.
func (g *game) dpiChanged(suggested *winRect) {
	if g.display == displayFullscreen || suggested == nil {
		g.coverMonitor()

		return
	}

	g.place(0, suggested.bounds(), swpNoZOrder|swpNoActivate|swpNoOwnerZOrder)
}

// closing is the window's end: keep how it was left, close the web view
// and end the message loop.
func (g *game) closing() {
	g.noteWindow()
	g.stopVoice()
	g.closeWebView()
	g.hwnd = 0

	_, _, _ = procPostQuitMessage.Call(0)
}

// leave ends the game for the default browser, saying why in the log.
func (g *game) leave(format string, args ...any) {
	if g.fallback != "" {
		return
	}

	g.fallback = fmt.Sprintf(format, args...)
	logf("leaving for the default browser: %s", g.fallback)

	if g.hwnd != 0 {
		_, _, _ = procDestroyWindow.Call(uintptr(g.hwnd))
	}
}

// alreadyRunning reports whether this game is already open in the reader's
// session. The first launch's mutex handle stays open until its process
// ends, which is how a later launch knows.
func alreadyRunning() bool {
	h, _, err := procCreateMutex.Call(0, 0, uintptr(unsafe.Pointer(utf16(mutexName(settings.StoryID)))))

	return h != 0 && errors.Is(err, syscall.ERROR_ALREADY_EXISTS)
}

// bringForward shows the open game's window, waiting a little for one that
// is still opening.
func bringForward() {
	class := utf16(windowClass(settings.StoryID))

	for range 30 {
		if hwnd, _, _ := procFindWindow.Call(uintptr(unsafe.Pointer(class)), 0); hwnd != 0 {
			if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
				_, _, _ = procShowWindow.Call(hwnd, swRestore)
			}

			_, _, _ = procSetForegroundWindow.Call(hwnd)

			return
		}

		time.Sleep(100 * time.Millisecond)
	}
}
