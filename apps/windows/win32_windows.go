package main

// The Win32 calls the exe makes, through syscall only (no cgo, no
// golang.org/x/sys), with the structs and constants they take. Struct
// layouts are the x64 ones (the exe is windows/amd64 only).

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	shcore   = syscall.NewLazyDLL("shcore.dll")

	procRegisterClassEx              = user32.NewProc("RegisterClassExW")
	procCreateWindowEx               = user32.NewProc("CreateWindowExW")
	procDefWindowProc                = user32.NewProc("DefWindowProcW")
	procDestroyWindow                = user32.NewProc("DestroyWindow")
	procShowWindow                   = user32.NewProc("ShowWindow")
	procGetMessage                   = user32.NewProc("GetMessageW")
	procTranslateMessage             = user32.NewProc("TranslateMessage")
	procDispatchMessage              = user32.NewProc("DispatchMessageW")
	procPostQuitMessage              = user32.NewProc("PostQuitMessage")
	procPostMessage                  = user32.NewProc("PostMessageW")
	procLoadImage                    = user32.NewProc("LoadImageW")
	procLoadCursor                   = user32.NewProc("LoadCursorW")
	procGetClientRect                = user32.NewProc("GetClientRect")
	procGetWindowRect                = user32.NewProc("GetWindowRect")
	procSetWindowText                = user32.NewProc("SetWindowTextW")
	procGetWindowLongPtr             = user32.NewProc("GetWindowLongPtrW")
	procSetWindowLongPtr             = user32.NewProc("SetWindowLongPtrW")
	procSetWindowPos                 = user32.NewProc("SetWindowPos")
	procGetWindowPlacement           = user32.NewProc("GetWindowPlacement")
	procSetWindowPlacement           = user32.NewProc("SetWindowPlacement")
	procMonitorFromWindow            = user32.NewProc("MonitorFromWindow")
	procGetMonitorInfo               = user32.NewProc("GetMonitorInfoW")
	procEnumDisplayMonitors          = user32.NewProc("EnumDisplayMonitors")
	procAdjustWindowRectExForDpi     = user32.NewProc("AdjustWindowRectExForDpi")
	procAdjustWindowRectEx           = user32.NewProc("AdjustWindowRectEx")
	procGetKeyState                  = user32.NewProc("GetKeyState")
	procFindWindow                   = user32.NewProc("FindWindowW")
	procSetForegroundWindow          = user32.NewProc("SetForegroundWindow")
	procIsIconic                     = user32.NewProc("IsIconic")
	procIsZoomed                     = user32.NewProc("IsZoomed")
	procMessageBox                   = user32.NewProc("MessageBoxW")
	procGetSystemMetrics             = user32.NewProc("GetSystemMetrics")
	procGetThreadDpiAwarenessContext = user32.NewProc("GetThreadDpiAwarenessContext")
	procAreDpiAwarenessContextsEqual = user32.NewProc("AreDpiAwarenessContextsEqual")
	procGetStockObject               = gdi32.NewProc("GetStockObject")
	procGetModuleHandle              = kernel32.NewProc("GetModuleHandleW")
	procCreateMutex                  = kernel32.NewProc("CreateMutexW")
	procCoInitializeEx               = ole32.NewProc("CoInitializeEx")
	procCoTaskMemFree                = ole32.NewProc("CoTaskMemFree")
	procSHGetKnownFolderPath         = shell32.NewProc("SHGetKnownFolderPath")
	procGetDpiForMonitor             = shcore.NewProc("GetDpiForMonitor")
)

// Window messages (WinUser.h).
const (
	wmDestroy        = 0x0002
	wmMove           = 0x0003
	wmSize           = 0x0005
	wmSetFocus       = 0x0007
	wmClose          = 0x0010
	wmDisplayChange  = 0x007E
	wmMoving         = 0x0216
	wmEnterSizeMove  = 0x0231
	wmExitSizeMove   = 0x0232
	wmDpiChanged     = 0x02E0
	wmApp            = 0x8000
	wmAppToggle      = wmApp + 1 // F11
	wmAppDisplay     = wmApp + 2 // the page's switch: wParam 1 fullscreen, 0 window
	wmAppReload      = wmApp + 3 // F5, Ctrl+R, a crashed page
	wmAppRestart     = wmApp + 4 // the web view's browser process ended
	sizeRestored     = 0
	sizeMinimized    = 1
	sizeMaximized    = 2
	swShow           = 5
	swShowMaximized  = 3
	swRestore        = 9
	swpNoSize        = 0x0001
	swpNoMove        = 0x0002
	swpNoZOrder      = 0x0004
	swpNoActivate    = 0x0010
	swpFrameChanged  = 0x0020
	swpNoOwnerZOrder = 0x0200

	monitorDefaultToNearest = 2
	monitorInfoPrimary      = 1
	mdtEffectiveDPI         = 0
	blackBrush              = 4
	idcArrow                = 32512
	imageIcon               = 1
	iconResource            = 1 // the RT_GROUP_ICON windows_resources.py writes
	smCXIcon                = 11
	smCYIcon                = 12
	smCXSmIcon              = 49
	smCYSmIcon              = 50
	vkControl               = 0x11
	vkMenu                  = 0x12
	coinitApartmentThreaded = 0x2
	mbIconError             = 0x10
	createNoWindow          = 0x08000000 // CREATE_NO_WINDOW
)

// winRect is a Win32 RECT.
type winRect struct{ Left, Top, Right, Bottom int32 }

func (r winRect) rect() rect {
	return rect{Left: int(r.Left), Top: int(r.Top), W: int(r.Right - r.Left), H: int(r.Bottom - r.Top)}
}

func (r winRect) bounds() windowBounds {
	return windowBounds{Left: int(r.Left), Top: int(r.Top), Width: int(r.Right - r.Left), Height: int(r.Bottom - r.Top)}
}

// winPoint is a Win32 POINT.
type winPoint struct{ X, Y int32 }

// wndClassEx is WNDCLASSEXW (80 bytes on x64).
type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   syscall.Handle
	Icon       syscall.Handle
	Cursor     syscall.Handle
	Background syscall.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     syscall.Handle
}

// winMsg is MSG (48 bytes on x64).
type winMsg struct {
	Hwnd    syscall.Handle
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      winPoint
	Private uint32
}

// monitorInfo is MONITORINFO.
type monitorInfo struct {
	Size    uint32
	Monitor winRect
	Work    winRect
	Flags   uint32
}

// windowPlacement is WINDOWPLACEMENT.
type windowPlacement struct {
	Length    uint32
	Flags     uint32
	ShowCmd   uint32
	MinPos    winPoint
	MaxPos    winPoint
	NormalPos winRect
}

// utf16 is text as a NUL-terminated UTF-16 string for a Win32 call; text
// holding a NUL (never passed here) becomes the empty string.
func utf16(text string) *uint16 {
	p, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("")
	}

	return p
}

// utf16At reads a NUL-terminated UTF-16 string Windows handed over.
func utf16At(p *uint16) string {
	if p == nil {
		return ""
	}

	n := 0
	for *(*uint16)(unsafe.Add(unsafe.Pointer(p), 2*n)) != 0 {
		n++
	}

	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

// ptrAt is a pointer Windows handed over as a number (a message's lParam,
// a COM callback's argument).
func ptrAt[T any](p uintptr) *T {
	return *(**T)(unsafe.Pointer(&p))
}

// coTaskMemFree frees a string WebView2 or the shell allocated.
func coTaskMemFree(p *uint16) {
	if p != nil {
		_, _, _ = procCoTaskMemFree.Call(uintptr(unsafe.Pointer(p)))
	}
}

// postMessage queues a message to hwnd.
func postMessage(hwnd syscall.Handle, message uint32, wParam uintptr) {
	_, _, _ = procPostMessage.Call(uintptr(hwnd), uintptr(message), wParam, 0)
}

// keyIsDown reports whether a key (VK_CONTROL, VK_MENU) is held, as the
// thread's input state has it.
func keyIsDown(virtualKey uintptr) bool {
	state, _, _ := procGetKeyState.Call(virtualKey)

	return int16(state) < 0
}

// enumerated collects EnumDisplayMonitors' monitors for listMonitors.
var enumerated []syscall.Handle

// enumMonitor is EnumDisplayMonitors' callback, made once.
var enumMonitor = syscall.NewCallback(func(hmon, hdc syscall.Handle, clip *winRect, data uintptr) uintptr {
	enumerated = append(enumerated, hmon)

	return 1
})

// listMonitors lists the connected displays and the primary one's index.
func listMonitors() ([]monitor, int) {
	enumerated = nil
	_, _, _ = procEnumDisplayMonitors.Call(0, 0, enumMonitor, 0)

	var out []monitor

	primary := 0

	for _, h := range enumerated {
		m, isPrimary, ok := monitorOf(h)
		if !ok {
			continue
		}

		if isPrimary {
			primary = len(out)
		}

		out = append(out, m)
	}

	return out, primary
}

// monitorOf reads a display's areas and DPI, and whether it is the
// primary one.
func monitorOf(h syscall.Handle) (monitor, bool, bool) {
	mi := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
	if ok, _, _ := procGetMonitorInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&mi))); ok == 0 {
		return monitor{}, false, false
	}

	return monitor{Area: mi.Monitor.rect(), Work: mi.Work.rect(), DPI: monitorDPI(h)}, mi.Flags&monitorInfoPrimary != 0, true
}

// monitorDPI is a display's effective DPI (96 where Windows cannot say).
func monitorDPI(h syscall.Handle) int {
	if procGetDpiForMonitor.Find() != nil {
		return baseDPI
	}

	var x, y uint32

	hr, _, _ := procGetDpiForMonitor.Call(uintptr(h), mdtEffectiveDPI, uintptr(unsafe.Pointer(&x)), uintptr(unsafe.Pointer(&y)))
	if int32(hr) < 0 || x == 0 {
		return baseDPI
	}

	return int(x)
}

// windowMonitor is the display holding most of hwnd.
func windowMonitor(hwnd syscall.Handle) monitor {
	h, _, _ := procMonitorFromWindow.Call(uintptr(hwnd), monitorDefaultToNearest)
	if m, _, ok := monitorOf(syscall.Handle(h)); ok {
		return m
	}

	return fallbackMonitor
}

// windowFrame is what a framed window adds around its client area at a
// DPI: the borders (Windows' invisible resize borders included) and the
// title bar.
func windowFrame(dpi int) size {
	var r winRect

	style := uintptr(wsOverlappedWindow | wsClipChildren)
	if procAdjustWindowRectExForDpi.Find() == nil {
		if ok, _, _ := procAdjustWindowRectExForDpi.Call(uintptr(unsafe.Pointer(&r)), style, 0, 0, uintptr(dpi)); ok != 0 {
			return size{int(r.Right - r.Left), int(r.Bottom - r.Top)}
		}
	}

	r = winRect{}
	if ok, _, _ := procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&r)), style, 0, 0); ok != 0 {
		return size{int(r.Right - r.Left), int(r.Bottom - r.Top)}
	}

	return size{16, 39}
}

// dpiAwareness says, for the log, whether the manifest made the exe
// per-monitor DPI aware (v2).
func dpiAwareness() string {
	if procGetThreadDpiAwarenessContext.Find() != nil || procAreDpiAwarenessContextsEqual.Find() != nil {
		return "unknown (Windows before 10 1607)"
	}

	context, _, _ := procGetThreadDpiAwarenessContext.Call()
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is ((DPI_AWARENESS_CONTEXT)-4).
	if same, _, _ := procAreDpiAwarenessContextsEqual.Call(context, ^uintptr(3)); same != 0 {
		return "per-monitor v2"
	}

	return "NOT per-monitor v2 (the manifest did not apply)"
}

// folderIDDownloads is FOLDERID_Downloads (KnownFolders.h).
var folderIDDownloads = mustGUID("374DE290-123F-4565-9164-39C4925E467B")

// downloadsFolder is the reader's Downloads folder, wherever they moved it.
func downloadsFolder() (string, error) {
	var p *uint16

	hr, _, _ := procSHGetKnownFolderPath.Call(uintptr(unsafe.Pointer(&folderIDDownloads)), 0, 0, uintptr(unsafe.Pointer(&p)))
	defer coTaskMemFree(p)

	if int32(hr) < 0 {
		return "", errors.New("SHGetKnownFolderPath(Downloads): " + hresult(int32(hr)))
	}

	return utf16At(p), nil
}

// hidden is a helper command that runs without a console window.
func hidden(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}

	return cmd
}

// openInBrowser opens the page in the default browser, as a double-click
// on it would.
func openInBrowser(page string) {
	if err := hidden("rundll32.exe", "url.dll,FileProtocolHandler", page).Start(); err != nil {
		logf("opening %s in the default browser: %v", page, err)
	}
}

// fail shows message in an error box captioned with the game's title, then
// exits.
func fail(message string) {
	_, _, _ = procMessageBox.Call(0, uintptr(unsafe.Pointer(utf16(message))), uintptr(unsafe.Pointer(utf16(gameTitle()))), mbIconError)

	os.Exit(1)
}
