package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// The UI (the window, its messages and every WebView2 call and callback)
// runs on the main thread, as COM's single-threaded apartment needs.
func init() {
	runtime.LockOSThread()
}

func main() {
	// Once, before anything else: the game's settings (settings.go).
	settings = loadSettings()

	// Tools and tests: the settings as read, written to a file, no window.
	if path, ok := selfCheckPath(os.Args[1:]); ok {
		os.Exit(selfCheck(path, settings))
	}

	// For the author, not a reader: the exe as each release builds it,
	// before `kinetic apps` gives it a game, so in English.
	if settings.StoryID == "" {
		fail("This program was made without its game's details.\n\n" +
			"Make it with kinetic apps --windows, or open the game's index.html instead.")
	}

	// A reader who moved the exe: in their display language.
	page, err := gamePage()
	if err != nil {
		failWith("host.windows.missing", map[string]string{"title": gameTitle(), "file": pageName})
	}

	// A second launch while the game is open brings it forward.
	if alreadyRunning() {
		bringForward()

		return
	}

	dir := dataDir(os.Getenv, settings.StoryID)
	if dir == "" {
		openInBrowser(page)

		return
	}

	closeLog := openLog(dir)
	defer closeLog()

	exe, _ := os.Executable()
	logf("start %s: story %s, title %q, made by Kinetic %s", exe, settings.StoryID, gameTitle(),
		settings.KineticVersion)
	logf("page %s; data folder %s; DPI awareness %s", fileURL(page), dir, dpiAwareness())

	rt, ok := findRuntime()
	if !ok {
		logf("no WebView2 Runtime found: opening %s in the default browser", pageName)
		openInBrowser(page)

		return
	}

	g := &game{page: page, pageURL: fileURL(page), dir: dir, runtime: rt, content: firstContent()}
	g.run()

	if g.fallback != "" {
		openInBrowser(page)
	}

	logf("end")
}

// findRuntime looks for the WebView2 Runtime where the registry says it
// is, logging what it read.
func findRuntime() (runtimeCandidate, bool) {
	readings := readRuntimeRegistry()
	for _, r := range readings {
		logf("registry %s: EBWebView %q, pv %q, location %q", r.View, r.Folder, r.Version, r.Location)
	}

	rt, ok := pickRuntime(runtimeCandidates(readings, os.Getenv), isFile)
	if ok {
		logf("WebView2 Runtime %s at %s (from %s)", rt.Version, rt.Folder, rt.From)
	}

	return rt, ok
}

// run opens the game window in the remembered mode, starts the web view
// in it, and serves the window until it closes.
func (g *game) run() {
	// Read when the environment is created (createEnvironment below).
	for _, v := range webViewEnvironment(os.Getenv) {
		_ = os.Setenv(v.Name, v.Value)
		logf("%s=%s", v.Name, v.Value)
	}

	hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded)
	logf("CoInitializeEx: %s", hresult(int32(hr)))

	monitors, primary := listMonitors()
	g.memory = loadMemory(memoryPath(g.dir))
	s := planStart(g.memory, monitors, primary, g.content, windowFrame)
	g.display = displayWindow

	if s.Fullscreen {
		g.display = displayFullscreen
	}

	logf("monitors %+v (primary %d)", monitors, primary)
	logf("memory %s %+v maximized %v; first window content %v", g.memory.Display, g.memory.Bounds,
		g.memory.Maximized, g.content)
	logf("start %s on %+v: window %+v maximized %v first %v", g.display, s.Monitor, s.Normal, s.Maximized, s.First)

	g.makeHandlers()

	if err := g.createWindow(s); err != nil {
		g.leave("opening the game window: %v", err)

		return
	}

	g.startVoice()
	g.createEnvironment()
	messageLoop()
}

// gamePage is the index.html beside this program.
func gamePage() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}

	page := filepath.Join(filepath.Dir(exe), pageName)
	if !isFile(page) {
		return "", errors.New(page + " is not a file")
	}

	return page, nil
}

// isFile reports whether path is a regular file.
func isFile(path string) bool {
	info, err := os.Stat(path)

	return err == nil && info.Mode().IsRegular()
}
