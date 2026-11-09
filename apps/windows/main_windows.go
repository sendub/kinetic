package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	pageName = "index.html"
	// logFile is the controller's log, in the game's profile folder.
	logFile = "kinetic-host.log"

	createNoWindow = 0x08000000 // CREATE_NO_WINDOW
	synchronize    = 0x00100000 // SYNCHRONIZE access to a process
	mbIconError    = 0x10       // MB_ICONERROR

	spiGetWorkArea    = 0x0030 // SPI_GETWORKAREA
	smXVirtualScreen  = 76     // SM_XVIRTUALSCREEN
	smYVirtualScreen  = 77     // SM_YVIRTUALSCREEN
	smCXVirtualScreen = 78     // SM_CXVIRTUALSCREEN
	smCYVirtualScreen = 79     // SM_CYVIRTUALSCREEN

	politeCloseMillis = 5000
	forcedCloseMillis = 3000

	// connectWait is how long a starting browser has to open its
	// DevTools connection.
	connectWait = 10 * time.Second
)

var (
	user32                   = syscall.NewLazyDLL("user32.dll")
	procSystemParametersInfo = user32.NewProc("SystemParametersInfoW")
	procGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	procMessageBox           = user32.NewProc("MessageBoxW")
)

// fallbackWorkArea stands in when Windows does not say: a small laptop's.
var fallbackWorkArea = rect{W: 1366, H: 728}

func main() {
	if storyID == "" {
		fail("This program was built without its game's details.\n\n" +
			"Build it with tools/build_apps.py --windows, or open the game's index.html instead.")
	}

	page, err := gamePage()
	if err != nil {
		fail(gameTitle() + " cannot find " + pageName + " next to this program.\n\n" +
			"Keep the program inside its game folder, or open the folder's " + pageName + " instead.")
	}

	profile := profileDir(os.Getenv, storyID)
	if profile != "" {
		// The browser applies its start mode only when its process
		// starts, so a second launch while the game is open would get
		// whatever window is there: close this game's browser first
		// (whose exe then ends) and start it afresh. The player resumes
		// where the reader was.
		stopRunning(profile)

		work, screen := workArea(), virtualScreen()
		memory := loadMemory(memoryPath(profile))
		first := func(frame size) windowBounds { return firstBounds(work, firstContent(), frame) }
		plan := planStart(memory, screen, first)
		pageURL := fileURL(page)

		// The port file of an earlier run would point at a closed port.
		_ = os.Remove(filepath.Join(profile, devToolsPortFile))

		if browser, err := startBrowser(browserPaths(os.Getenv), browserArgs(profile, pageURL, plan)); err == nil {
			steer(browser, profile, controllerConfig{
				PageURL:    pageURL,
				MemoryPath: memoryPath(profile),
				Memory:     memory,
				Start:      plan,
				Screen:     screen,
				First:      first,
			})

			return
		}
	}

	// No Edge or Chrome: the default browser, as a double-click would.
	_ = hidden("rundll32.exe", "url.dll,FileProtocolHandler", page).Start()
}

// steer waits for the browser's DevTools connection and runs the
// controller on it until the browser closes. With no connection in
// connectWait (a policy can turn the port off), the game plays on with no
// host object, as in a browser tab, and the exe ends.
func steer(browser *os.Process, profile string, cfg controllerConfig) {
	log := openLog(profile)
	if log != nil {
		defer func() { _ = log.Close() }()

		cfg.Logf = func(format string, args ...any) {
			_, _ = fmt.Fprintf(log, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
		}
	} else {
		cfg.Logf = func(string, ...any) {}
	}

	cfg.Logf("started %s; start %+v", cfg.PageURL, cfg.Start)

	exited := make(chan struct{})

	go func() {
		_, _ = browser.Wait()
		close(exited)
	}()

	alive := func() bool {
		select {
		case <-exited:
			return false
		default:
			return true
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), connectWait)
	endpoint, err := waitForDevTools(ctx, profile, alive)

	cancel()

	if err != nil {
		cfg.Logf("no DevTools connection: %v", err)

		return
	}

	cfg.Endpoint = endpoint
	err = runController(context.Background(), cfg)
	cfg.Logf("done: %v", err)
}

// openLog truncates and opens the controller's log in profile, which a
// reader can send when the window controls misbehave; nil when it cannot.
func openLog(profile string) *os.File {
	if os.MkdirAll(profile, 0o755) != nil {
		return nil
	}

	log, err := os.Create(filepath.Join(profile, logFile))
	if err != nil {
		return nil
	}

	return log
}

// workArea is the primary display's work area (the screen less the
// taskbar), in logical pixels: this exe has no DPI manifest, so Windows
// scales what it reports to 96 DPI, which matches Chrome's DIPs.
func workArea() rect {
	var r winRect

	ok, _, _ := procSystemParametersInfo.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&r)), 0)
	if ok == 0 || r.Right <= r.Left || r.Bottom <= r.Top {
		return fallbackWorkArea
	}

	return rect{Left: int(r.Left), Top: int(r.Top), W: int(r.Right - r.Left), H: int(r.Bottom - r.Top)}
}

// virtualScreen is the box around every display, in logical pixels.
func virtualScreen() rect {
	metric := func(index uintptr) int {
		v, _, _ := procGetSystemMetrics.Call(index)

		return int(int32(v))
	}

	screen := rect{
		Left: metric(smXVirtualScreen), Top: metric(smYVirtualScreen),
		W: metric(smCXVirtualScreen), H: metric(smCYVirtualScreen),
	}
	if screen.W <= 0 || screen.H <= 0 {
		return workArea()
	}

	return screen
}

// winRect is a Win32 RECT.
type winRect struct{ Left, Top, Right, Bottom int32 }

// gamePage is the index.html beside this program.
func gamePage() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}

	page := filepath.Join(filepath.Dir(exe), pageName)

	info, err := os.Stat(page)
	if err != nil {
		return "", err
	}

	if !info.Mode().IsRegular() {
		return "", errors.New(page + " is not a file")
	}

	return page, nil
}

// errNoBrowser says none of the browser paths could be started.
var errNoBrowser = errors.New("no Edge or Chrome found")

// startBrowser starts the first browser in paths that exists, with args,
// and returns its process.
func startBrowser(paths, args []string) (*os.Process, error) {
	for _, browser := range paths {
		if _, err := os.Stat(browser); err != nil {
			continue
		}

		cmd := exec.Command(browser, args...)
		if cmd.Start() == nil {
			return cmd.Process, nil
		}
	}

	return nil, errNoBrowser
}

// runningBrowsers lists the process ids of the Edge or Chrome browser
// processes (not their helpers, which carry --type=) started with profile.
func runningBrowsers(profile string) []int {
	ps := hidden("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		`Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | `+
			`Where-Object { $_.CommandLine -and `+
			`$_.CommandLine.Contains('--user-data-dir=' + $env:KINETIC_PROFILE) -and `+
			`-not $_.CommandLine.Contains('--type=') } | `+
			`ForEach-Object { $_.ProcessId }`)
	ps.Env = append(os.Environ(), "KINETIC_PROFILE="+profile)

	out, err := ps.Output()
	if err != nil {
		return nil
	}

	var pids []int

	for _, field := range strings.Fields(string(out)) {
		if pid, err := strconv.Atoi(field); err == nil {
			pids = append(pids, pid)
		}
	}

	return pids
}

// stopRunning closes the browser that owns profile, if any: politely
// (WM_CLOSE, the browser's clean shutdown) first, then forcefully when it
// is still running after 5 s.
func stopRunning(profile string) {
	for _, pid := range runningBrowsers(profile) {
		id := strconv.Itoa(pid)
		handle, err := syscall.OpenProcess(synchronize, false, uint32(pid))
		_ = hidden("taskkill.exe", "/PID", id).Run()

		if err != nil {
			continue
		}

		if event, _ := syscall.WaitForSingleObject(handle, politeCloseMillis); event != syscall.WAIT_OBJECT_0 {
			_ = hidden("taskkill.exe", "/F", "/PID", id).Run()
			_, _ = syscall.WaitForSingleObject(handle, forcedCloseMillis)
		}

		_ = syscall.CloseHandle(handle)
	}
}

// hidden is a helper command that runs without a console window.
func hidden(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}

	return cmd
}

// fail shows message in an error box captioned with the game's title, then
// exits.
func fail(message string) {
	text, _ := syscall.UTF16PtrFromString(message)
	caption, _ := syscall.UTF16PtrFromString(gameTitle())
	_, _, _ = procMessageBox.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), mbIconError)

	os.Exit(1)
}
