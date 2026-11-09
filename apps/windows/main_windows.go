package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const (
	pageName = "index.html"

	createNoWindow = 0x08000000 // CREATE_NO_WINDOW
	synchronize    = 0x00100000 // SYNCHRONIZE access to a process
	mbIconError    = 0x10       // MB_ICONERROR

	politeCloseMillis = 5000
	forcedCloseMillis = 3000
)

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
		// The browser applies --start-fullscreen only when its process
		// starts, so a second launch while the game is open would get a
		// plain window: close this game's browser first and start it
		// afresh. The player resumes where the reader was.
		stopRunning(profile)

		if _, err := startBrowser(browserPaths(os.Getenv), browserArgs(profile, page)); err == nil {
			return
		}
	}

	// No Edge or Chrome: the default browser, as a double-click would.
	_ = hidden("rundll32.exe", "url.dll,FileProtocolHandler", page).Start()
}

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
	box := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	text, _ := syscall.UTF16PtrFromString(message)
	caption, _ := syscall.UTF16PtrFromString(gameTitle())
	_, _, _ = box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(caption)), mbIconError)

	os.Exit(1)
}
