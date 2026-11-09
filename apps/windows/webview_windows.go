package main

// The game's web view: WebView2 in the game window, created straight from
// the installed runtime's EmbeddedBrowserWebView.dll (runtime.go says
// where it comes from), set up as a game screen, and wired to the page
// through the host object (host.go).

import (
	"os"
	"strings"
	"syscall"
	"unsafe"
)

const (
	// createExport is the runtime DLL's environment-creation export, as
	// WebView2Loader calls it (jchv/OpenWebView2Loader, wailsapp/go-webview2):
	// HRESULT (BOOL unknown, int runtimeType, LPCWSTR userDataFolder,
	// ICoreWebView2EnvironmentOptions* options,
	// ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler* handler).
	// The loader passes TRUE first, runtime type 0 for an installed
	// runtime, and options may be NULL.
	createExport     = "CreateWebViewEnvironmentWithOptionsInternal"
	runtimeInstalled = 0
	// maxRestarts bounds how often the web view is made again after its
	// browser process ends.
	maxRestarts = 3
)

// webView is the game's WebView2 state.
type webView struct {
	create *syscall.Proc
	env    *comObject
	ctrl   *comObject
	view   *comObject

	// scriptID is the creation script in force; pending lists the displays
	// of the scripts being added, oldest first.
	scriptID  string
	pending   []string
	navigated bool
	retried   bool
	restarts  int
	// given holds the download paths handed out this run, lower case.
	given map[string]bool

	onEnvironment, onController, onScript, onExecuted         *comHandler
	onKey, onMessage, onNewWindow, onTitle, onFailed, onSaved *comHandler
}

// makeHandlers makes the game's handler objects, once.
func (g *game) makeHandlers() {
	g.given = map[string]bool{}
	g.onEnvironment = newHandler("environment created", iidEnvironmentCompleted, g.environmentCreated)
	g.onController = newHandler("controller created", iidControllerCompleted, g.controllerCreated)
	g.onScript = newHandler("host script added", iidAddScriptCompleted, g.scriptAdded)
	g.onExecuted = newHandler("display sent", iidExecuteScriptCompleted, func(a, _ uintptr) {
		if hr := int32(a); hr < 0 {
			logf("telling the page its display: %s", hresult(hr))
		}
	})
	g.onKey = newHandler("accelerator key", iidAcceleratorKeyPressed, g.acceleratorKey)
	g.onMessage = newHandler("web message", iidWebMessageReceived, g.webMessage)
	g.onNewWindow = newHandler("new window", iidNewWindowRequested, g.newWindow)
	g.onTitle = newHandler("title", iidDocumentTitleChanged, func(uintptr, uintptr) { g.showTitle() })
	g.onFailed = newHandler("process failed", iidProcessFailed, g.processFailed)
	g.onSaved = newHandler("download", iidDownloadStarting, g.downloadStarting)
}

// createEnvironment starts creating the WebView2 environment, with the
// game's data folder; environmentCreated carries on.
func (g *game) createEnvironment() {
	if g.create == nil {
		dll, err := syscall.LoadDLL(runtimeDLL(g.runtime.Folder))
		if err != nil {
			g.leave("loading %s: %v", runtimeDLL(g.runtime.Folder), err)

			return
		}

		if g.create, err = dll.FindProc(createExport); err != nil {
			g.leave("%s has no %s: %v", runtimeDLL(g.runtime.Folder), createExport, err)

			return
		}
	}

	r, _, _ := g.create.Call(1, runtimeInstalled, uintptr(unsafe.Pointer(utf16(g.dir))), 0,
		uintptr(unsafe.Pointer(g.onEnvironment)))
	logf("%s: %s", createExport, hresult(int32(r)))

	if int32(r) < 0 {
		g.leave("the WebView2 environment could not be created (%s)", hresult(int32(r)))
	}
}

// environmentCreated creates the controller in the game window, or tries
// the environment once more, as WebView2Loader does.
func (g *game) environmentCreated(a, b uintptr) {
	hr := int32(a)
	logf("environment: %s", hresult(hr))

	if g.hwnd == 0 {
		return
	}

	if hr < 0 || b == 0 {
		if !g.retried {
			g.retried = true

			g.createEnvironment()

			return
		}

		g.leave("the WebView2 environment was not created (%s)", hresult(hr))

		return
	}

	g.env.release()
	g.env = comAt(b).query(&iidEnvironment)

	if g.env == nil {
		g.leave("the WebView2 environment has no ICoreWebView2Environment")

		return
	}

	hr = g.env.call(envCreateCoreWebView2Controller, uintptr(g.hwnd), uintptr(unsafe.Pointer(g.onController)))
	logf("CreateCoreWebView2Controller: %s", hresult(hr))

	if hr < 0 {
		g.leave("the WebView2 controller could not be created (%s)", hresult(hr))
	}
}

// controllerCreated sets the new web view up and loads the game.
func (g *game) controllerCreated(a, b uintptr) {
	hr := int32(a)
	logf("controller: %s", hresult(hr))

	if hr < 0 || b == 0 {
		g.leave("the WebView2 controller was not created (%s)", hresult(hr))

		return
	}

	ctrl := comAt(b)
	ctrl.addRef()

	if g.hwnd == 0 {
		ctrl.call(ctrlClose)
		ctrl.release()

		return
	}

	g.ctrl = ctrl

	if c2 := ctrl.query(&iidController2); c2 != nil {
		logResult("black background", c2.call(ctrl2PutDefaultBackgroundColor, opaqueBlack))
		c2.release()
	}

	g.fitWebView(true)

	view, hr := ctrl.getObject(ctrlGetCoreWebView2)
	if hr < 0 || view == nil {
		g.leave("the WebView2 controller has no web view (%s)", hresult(hr))

		return
	}

	g.view = view
	g.configure()
	g.listen()
	g.installScript(g.display)
	g.focusWebView()
}

// logResult logs a failed setup step.
func logResult(step string, hr int32) {
	if hr < 0 {
		logf("%s: %s", step, hresult(hr))
	}
}

// configure turns off what a game screen does not want: the context menu,
// the zoom keys and pinch, the status bar, dev tools and the browser's
// own keys (find, print, reload, zoom; the exe does reload itself).
func (g *game) configure() {
	settings, hr := g.view.getObject(wvGetSettings)
	if hr < 0 || settings == nil {
		logf("settings: %s", hresult(hr))

		return
	}

	defer settings.release()

	logResult("context menus off", settings.putBool(setPutAreDefaultContextMenusEnabled, false))
	logResult("zoom control off", settings.putBool(setPutIsZoomControlEnabled, false))
	logResult("status bar off", settings.putBool(setPutIsStatusBarEnabled, false))
	logResult("dev tools off", settings.putBool(setPutAreDevToolsEnabled, false))

	if s3 := settings.query(&iidSettings3); s3 != nil {
		logResult("browser keys off", s3.putBool(set3PutAreBrowserAcceleratorKeysEnabled, false))
		s3.release()
	} else {
		logf("settings: no ICoreWebView2Settings3, so the browser's keys stay on")
	}

	if s5 := settings.query(&iidSettings5); s5 != nil {
		logResult("pinch zoom off", s5.putBool(set5PutIsPinchZoomEnabled, false))
		s5.release()
	}
}

// listen adds the event handlers.
func (g *game) listen() {
	var token int64

	add := func(o *comObject, method int, h *comHandler) {
		hr := o.call(method, uintptr(unsafe.Pointer(h)), uintptr(unsafe.Pointer(&token)))
		logResult("adding the "+h.name+" handler", hr)
	}

	add(g.ctrl, ctrlAddAcceleratorKeyPressed, g.onKey)
	add(g.view, wvAddWebMessageReceived, g.onMessage)
	add(g.view, wvAddNewWindowRequested, g.onNewWindow)
	add(g.view, wvAddDocumentTitleChanged, g.onTitle)
	add(g.view, wvAddProcessFailed, g.onFailed)

	if v4 := g.view.query(&iidWebView4); v4 != nil {
		add(v4, wv4AddDownloadStarting, g.onSaved)
		v4.release()
	} else {
		logf("no ICoreWebView2_4: Export shows the engine's own download bubble")
	}
}

// installScript adds the creation script for display; scriptAdded then
// drops the one it replaces (a document begun in between runs both, and
// the later one wins) and, the first time, loads the game.
func (g *game) installScript(display string) {
	g.pending = append(g.pending, display)

	hr := g.view.call(wvAddScriptToExecuteOnDocumentCreated, uintptr(unsafe.Pointer(utf16(hostScript(display)))),
		uintptr(unsafe.Pointer(g.onScript)))
	if hr >= 0 {
		return
	}

	logf("adding the host script for %s: %s", display, hresult(hr))
	g.pending = g.pending[:len(g.pending)-1]
	g.navigate()
}

func (g *game) scriptAdded(a, b uintptr) {
	hr := int32(a)

	display := ""
	if len(g.pending) > 0 {
		display, g.pending = g.pending[0], g.pending[1:]
	}

	if hr < 0 {
		logf("the host script for %s was not added: %s", display, hresult(hr))
	} else {
		id := utf16At(ptrAt[uint16](b))
		if g.scriptID != "" {
			logResult("removing the old host script", g.view.putString(wvRemoveScriptToExecuteOnDocumentCreated, g.scriptID))
		}

		g.scriptID = id
		logf("host script for %s in force (%s)", display, id)
	}

	g.navigate()
}

// navigate loads the game's page, once.
func (g *game) navigate() {
	if g.navigated || g.view == nil {
		return
	}

	g.navigated = true
	logf("navigate %s: %s", g.pageURL, hresult(g.view.putString(wvNavigate, g.pageURL)))
}

// tellPage gives the page the display now: the creation script first, so
// a reload starts in it, then the page in front.
func (g *game) tellPage() {
	if g.view == nil {
		return
	}

	g.installScript(g.display)
	logResult("telling the page its display", g.view.call(wvExecuteScript,
		uintptr(unsafe.Pointer(utf16(setterScript(g.display)))), uintptr(unsafe.Pointer(g.onExecuted))))
}

// acceleratorKey keeps F11, F5 and Ctrl+R for the exe and leaves every
// other key to the page. The web view waits on this handler, so the work
// is posted to the window for after it returns.
func (g *game) acceleratorKey(_, b uintptr) {
	args := comAt(b)

	var kind, key uint32

	var lParam int32

	args.call(keyGetKeyEventKind, uintptr(unsafe.Pointer(&kind)))
	args.call(keyGetVirtualKey, uintptr(unsafe.Pointer(&key)))
	args.call(keyGetKeyEventLParam, uintptr(unsafe.Pointer(&lParam)))

	act := acceleratorAction(kind, key, lParam, keyIsDown(vkControl), keyIsDown(vkMenu))
	if act == keyPass {
		return
	}

	args.putBool(keyPutHandled, true)

	switch act {
	case keyToggle:
		postMessage(g.hwnd, wmAppToggle, 0)
	case keyReload:
		postMessage(g.hwnd, wmAppReload, 0)
	}
}

// webMessage carries out a message from the game's own page.
func (g *game) webMessage(_, b uintptr) {
	args := comAt(b)
	source, _ := args.getString(msgGetSource)
	text, _ := args.getString(msgGetWebMessageAsJSON)

	if !fromGame(source, g.pageURL) {
		logf("ignored a message from %s", source)

		return
	}

	logf("the page sent %s", text)

	m, ok := parseMessage(text)
	if !ok {
		return
	}

	switch {
	case m.Type == "quit":
		postMessage(g.hwnd, wmClose, 0)
	case m.Mode == displayFullscreen:
		postMessage(g.hwnd, wmAppDisplay, 1)
	default:
		postMessage(g.hwnd, wmAppDisplay, 0)
	}
}

// newWindow refuses every new window (window.open, a link to a new tab).
func (g *game) newWindow(_, b uintptr) {
	args := comAt(b)
	uri, _ := args.getString(newWindowGetURI)
	logf("refused a new window for %s: %s", uri, hresult(args.putBool(newWindowPutHandled, true)))
}

// showTitle gives the window the page's title.
func (g *game) showTitle() {
	if g.view == nil || g.hwnd == 0 {
		return
	}

	title, _ := g.view.getString(wvGetDocumentTitle)
	_, _, _ = procSetWindowText.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(utf16(windowTitle(title, gameTitle())))))
}

// processFailed reloads a page whose renderer ended, and makes the web
// view again when its browser process ended.
func (g *game) processFailed(_, b uintptr) {
	var kind int32

	comAt(b).call(failedGetProcessFailedKind, uintptr(unsafe.Pointer(&kind)))
	logf("process failed, kind %d", kind)

	switch kind {
	case renderProcessExited:
		postMessage(g.hwnd, wmAppReload, 0)
	case browserProcessExited:
		postMessage(g.hwnd, wmAppRestart, 0)
	case renderProcessUnresponsive:
		// WebView2 raises this every few seconds while the page is busy;
		// the page carries on once it is free.
	}
}

// downloadStarting saves Export's file into Downloads under a free name,
// with no download bubble.
func (g *game) downloadStarting(_, b uintptr) {
	args := comAt(b)
	suggested, _ := args.getString(downloadGetResultFilePath)

	if dir, err := downloadsFolder(); err != nil {
		logf("download: %v; saving where WebView2 chose", err)
	} else {
		target := freeName(dir, downloadName(suggested), g.taken)
		g.given[strings.ToLower(target)] = true
		logf("download %s saved as %s: %s", suggested, target,
			hresult(args.putString(downloadPutResultFilePath, target)))
	}

	logResult("hiding the download bubble", args.putBool(downloadPutHandled, true))
}

// taken reports whether a download path is in use.
func (g *game) taken(path string) bool {
	if g.given[strings.ToLower(path)] {
		return true
	}

	_, err := os.Lstat(path)

	return err == nil
}

// fitWebView sizes the web view to the window's client area, and hides it
// while the window is minimized.
func (g *game) fitWebView(visible bool) {
	if g.ctrl == nil {
		return
	}

	var r winRect

	_, _, _ = procGetClientRect.Call(uintptr(g.hwnd), uintptr(unsafe.Pointer(&r)))
	logResult("sizing the web view", g.ctrl.call(ctrlPutBounds, uintptr(unsafe.Pointer(&r))))
	g.ctrl.putBool(ctrlPutIsVisible, visible)
}

// webViewMoved tells the web view its window moved (popups, IME).
func (g *game) webViewMoved() {
	if g.ctrl != nil {
		g.ctrl.call(ctrlNotifyParentWindowPositionChanged)
	}
}

// focusWebView gives the page the keyboard.
func (g *game) focusWebView() {
	if g.ctrl != nil {
		g.ctrl.call(ctrlMoveFocus, moveFocusProgrammatic)
	}
}

// reload reloads the page in the mode in force.
func (g *game) reload() {
	if g.view != nil {
		logf("reload: %s", hresult(g.view.call(wvReload)))
	}
}

// restartWebView makes the web view again after its browser process
// ended (WebView2 has closed it), a few times at most.
func (g *game) restartWebView() {
	if g.restarts >= maxRestarts {
		g.leave("the WebView2 browser process ended %d times", g.restarts+1)

		return
	}

	g.restarts++
	logf("making the web view again (%d of %d)", g.restarts, maxRestarts)
	g.closeWebView()
	g.retried = false
	g.createEnvironment()
}

// closeWebView closes the web view and lets go of it.
func (g *game) closeWebView() {
	if g.ctrl != nil {
		g.ctrl.call(ctrlClose)
	}

	g.view.release()
	g.ctrl.release()
	g.env.release()
	g.view, g.ctrl, g.env = nil, nil, nil
	g.scriptID, g.pending, g.navigated = "", nil, false
}
