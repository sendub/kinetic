package main

// The controller against a real browser: headless Chrome on this machine
// (macOS in the repo's runs), started with the exe's own arguments plus
// --headless=new, on a tiny local page. Headless Chrome keeps window
// states and bounds as a real window would (an 800x600 screen, a 32-pixel
// frame above the page), so the switches show in Browser.getWindowBounds;
// it draws nothing on the screen.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

// testPage records what the host gave it: the object at document start
// (before the page's own scripts), and each kinetic-host event's display.
const testPage = `<!doctype html><meta charset="utf-8"><title>game</title>
<script>
  window.hostAtStart = window.kineticHost ? window.kineticHost.kind + "/" + window.kineticHost.display : null;
  window.hostEvents = [];
  addEventListener("kinetic-host", () => hostEvents.push(window.kineticHost ? window.kineticHost.display : null));
</script>
<body style="margin:0;background:#000"></body>`

// Headless Chrome's screen, and the content size the tests bake in: a
// 1080p first graphic, which must shrink to fit.
var (
	testScreen  = rect{0, 0, 800, 600}
	testContent = size{1920, 1080}
)

func testFirst(frame size) windowBounds { return firstBounds(testScreen, testContent, frame) }

// testBrowser is a headless Chrome started as the exe starts Edge, the
// test's own DevTools session on its page, and the controller under test.
type testBrowser struct {
	t        *testing.T
	root     string
	profile  string
	pageURL  string
	endpoint string
	cmd      *exec.Cmd
	exited   chan struct{}

	conn     *cdpConn
	session  string
	windowID int

	controllerDone chan error
	cancel         context.CancelFunc
}

// repoTmp is the repo's .tmp folder, where every test file goes.
func repoTmp(t *testing.T) string {
	t.Helper()

	root, err := filepath.Abs(filepath.Join("..", "..", ".tmp", "windows-app-tests"))
	if err != nil {
		t.Fatal(err)
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}

	return root
}

// startChrome launches headless Chrome with browserArgs for s and waits
// for the page to load, before any controller runs.
func startChrome(t *testing.T, s start) *testBrowser {
	t.Helper()

	if _, err := os.Stat(chromePath); err != nil {
		t.Skip("needs Google Chrome at " + chromePath)
	}

	root, err := os.MkdirTemp(repoTmp(t), "chrome-")
	if err != nil {
		t.Fatal(err)
	}

	page := filepath.Join(root, "game", "index.html")
	if err := os.MkdirAll(filepath.Dir(page), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(page, []byte(testPage), 0o644); err != nil {
		t.Fatal(err)
	}

	b := &testBrowser{
		t:       t,
		root:    root,
		profile: filepath.Join(root, "profile"),
		pageURL: (&url.URL{Scheme: "file", Path: page}).String(),
		exited:  make(chan struct{}),
	}

	args := append(browserArgs(b.profile, b.pageURL, s), "--headless=new",
		"--disable-crash-reporter", "--crash-dumps-dir="+filepath.Join(root, "crashes"))
	b.cmd = exec.Command(chromePath, args...)

	if err := b.cmd.Start(); err != nil {
		t.Fatal(err)
	}

	go func() {
		_ = b.cmd.Wait()
		close(b.exited)
	}()

	t.Cleanup(b.cleanup)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if b.endpoint, err = waitForDevTools(ctx, b.profile, b.alive); err != nil {
		t.Fatal(err)
	}

	if b.conn, err = dialCDP(ctx, b.endpoint); err != nil {
		t.Fatal(err)
	}

	var target targetInfo

	b.waitFor("the page target", func() (bool, string) {
		var list struct {
			TargetInfos []targetInfo `json:"targetInfos"`
		}
		_ = b.conn.call(ctx, "", "Target.getTargets", nil, &list)

		var ok bool

		target, ok = pickPage(list.TargetInfos, b.pageURL)

		return ok && target.URL == b.pageURL, fmt.Sprint(list.TargetInfos)
	})

	var attached struct {
		SessionID string `json:"sessionId"`
	}
	b.must(b.conn.call(ctx, "", "Target.attachToTarget",
		map[string]any{"targetId": target.TargetID, "flatten": true}, &attached))
	b.session = attached.SessionID

	var window struct {
		WindowID int `json:"windowId"`
	}
	b.must(b.conn.call(ctx, "", "Browser.getWindowForTarget", map[string]any{"targetId": target.TargetID}, &window))
	b.windowID = window.WindowID

	b.waitLoaded()

	return b
}

func (b *testBrowser) alive() bool {
	select {
	case <-b.exited:
		return false
	default:
		return true
	}
}

func (b *testBrowser) cleanup() {
	if b.cancel != nil {
		b.cancel()
		<-b.controllerDone
	}

	if b.conn != nil {
		_ = b.conn.Close()
	}

	if b.alive() {
		_ = b.cmd.Process.Kill()
		<-b.exited
	}

	_ = os.RemoveAll(b.root)
}

func (b *testBrowser) must(err error) {
	b.t.Helper()

	if err != nil {
		b.t.Fatal(err)
	}
}

// waitFor polls cond for up to 15 s; on a timeout it fails with cond's
// last account of what it saw.
func (b *testBrowser) waitFor(what string, cond func() (bool, string)) {
	b.t.Helper()

	deadline := time.Now().Add(15 * time.Second)

	for {
		ok, saw := cond()
		if ok {
			return
		}

		if time.Now().After(deadline) {
			b.t.Fatalf("waiting for %s: saw %s", what, saw)
		}

		time.Sleep(25 * time.Millisecond)
	}
}

// call runs a command on the test's own connection.
func (b *testBrowser) call(session, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return b.conn.call(ctx, session, method, params, result)
}

// eval evaluates expr in the page and decodes its value into out.
func (b *testBrowser) eval(expr string, out any) error {
	var got struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	if err := b.call(b.session, "Runtime.evaluate",
		map[string]any{"expression": expr, "returnByValue": true}, &got); err != nil {
		return err
	}

	if got.ExceptionDetails != nil {
		return errors.New(got.ExceptionDetails.Text)
	}

	if out == nil || len(got.Result.Value) == 0 {
		return nil
	}

	return json.Unmarshal(got.Result.Value, out)
}

func (b *testBrowser) waitLoaded() {
	b.t.Helper()
	b.waitFor("the page to load", func() (bool, string) {
		var state string
		err := b.eval("document.readyState", &state)

		return err == nil && state == "complete", fmt.Sprint(state, err)
	})
}

// pageHost is what the page sees of the host.
type pageHost struct {
	Kind    string   `json:"kind"`
	Display string   `json:"display"`
	Frozen  bool     `json:"frozen"`
	Send    bool     `json:"send"`
	AtStart *string  `json:"atStart"`
	Events  []string `json:"events"`
	Inner   []int    `json:"inner"`
}

func (b *testBrowser) host() pageHost {
	var h pageHost

	_ = b.eval(`({
		kind: window.kineticHost ? window.kineticHost.kind : "",
		display: window.kineticHost ? window.kineticHost.display : "",
		frozen: window.kineticHost ? Object.isFrozen(window.kineticHost) : false,
		send: window.kineticHost ? typeof window.kineticHost.send === "function" : false,
		atStart: window.hostAtStart,
		events: window.hostEvents,
		inner: [innerWidth, innerHeight],
	})`, &h)

	return h
}

func (b *testBrowser) send(message string) {
	b.t.Helper()
	b.must(b.eval("window.kineticHost.send("+message+")", nil))
}

func (b *testBrowser) bounds() cdpBounds {
	var got struct {
		Bounds cdpBounds `json:"bounds"`
	}
	_ = b.call("", "Browser.getWindowBounds", map[string]any{"windowId": b.windowID}, &got)

	return got.Bounds
}

// setWindow changes the window from outside the controller, as the
// reader's F11 or a drag would.
func (b *testBrowser) setWindow(bounds map[string]any) {
	b.t.Helper()
	b.must(b.call("", "Browser.setWindowBounds", map[string]any{"windowId": b.windowID, "bounds": bounds}, nil))
}

func (b *testBrowser) memoryPath() string { return memoryPath(b.profile) }

// runController starts the controller on the browser with s and memory.
func (b *testBrowser) runController(s start, memory windowMemory) {
	ctx, cancel := context.WithCancel(context.Background())
	b.cancel = cancel
	b.controllerDone = make(chan error, 1)
	cfg := controllerConfig{
		Endpoint:   b.endpoint,
		PageURL:    b.pageURL,
		MemoryPath: b.memoryPath(),
		Memory:     memory,
		Start:      s,
		Screen:     testScreen,
		First:      testFirst,
		Poll:       100 * time.Millisecond,
		Logf:       b.t.Logf,
	}

	go func() { b.controllerDone <- runController(ctx, cfg) }()
}

// controllerEnded waits for the controller to return by itself and
// gives its error.
func (b *testBrowser) controllerEnded() error {
	b.t.Helper()

	select {
	case err := <-b.controllerDone:
		b.cancel = nil

		return err
	case <-time.After(15 * time.Second):
		b.t.Fatal("the controller did not return")

		return nil
	}
}

func (b *testBrowser) browserExited() {
	b.t.Helper()

	select {
	case <-b.exited:
	case <-time.After(15 * time.Second):
		b.t.Fatal("Chrome did not exit")
	}
}

// frame is what the window adds around the page now.
func (b *testBrowser) frame() size {
	bounds, h := b.bounds(), b.host()
	if len(h.Inner) != 2 {
		return size{-1, -1}
	}

	return size{bounds.Width - h.Inner[0], bounds.Height - h.Inner[1]}
}

func (b *testBrowser) waitHost(what string, cond func(pageHost, cdpBounds) bool) pageHost {
	b.t.Helper()

	var h pageHost

	b.waitFor(what, func() (bool, string) {
		h = b.host()
		w := b.bounds()

		return cond(h, w), fmt.Sprintf("page %+v window %+v", h, w)
	})

	return h
}

func (b *testBrowser) waitMemory(what string, want windowMemory) {
	b.t.Helper()
	b.waitFor(what, func() (bool, string) {
		got := loadMemory(b.memoryPath())

		return reflect.DeepEqual(got, want), fmt.Sprintf("%+v %+v", got, got.Bounds)
	})
}

func lastEvent(h pageHost) string {
	if len(h.Events) == 0 {
		return ""
	}

	return h.Events[len(h.Events)-1]
}

// The exe's first launch: fullscreen, no memory. The page loads before the
// controller attaches.
func TestControllerFromAFullscreenStart(t *testing.T) {
	t.Parallel()

	fullscreen := start{Fullscreen: true}
	b := startChrome(t, fullscreen)

	if got := b.bounds().WindowState; got != stateFullscreen {
		t.Fatalf("--start-fullscreen opened a %s window", got)
	}

	if h := b.host(); h.Kind != "" || h.AtStart != nil {
		t.Fatalf("a host before the controller ran: %+v", h)
	}

	b.runController(fullscreen, windowMemory{Display: displayFullscreen})

	// The late object: defined in the loaded page, with the event fired.
	h := b.waitHost("the host object in the loaded page", func(h pageHost, _ cdpBounds) bool { return h.Kind != "" })
	if h.Kind != hostKind || h.Display != displayFullscreen || !h.Frozen || !h.Send {
		t.Errorf("host %+v, want a frozen windows-app host in fullscreen with send", h)
	}

	if !reflect.DeepEqual(h.Events, []string{displayFullscreen}) {
		t.Errorf("kinetic-host events %v, want one, for the late object", h.Events)
	}

	// After a reload the object is there before the page's own scripts.
	b.must(b.call(b.session, "Page.reload", nil, nil))
	b.waitLoaded()

	if h := b.host(); h.AtStart == nil || *h.AtStart != "windows-app/fullscreen" || h.Display != displayFullscreen {
		t.Errorf("after a reload the page started with %v (%+v), want windows-app/fullscreen", h.AtStart, h)
	}

	// Messages that are not the protocol's change nothing.
	b.must(b.eval(`window.__kineticHostSend("not json");
		window.kineticHost.send({type: "display", mode: "sideways"});
		window.kineticHost.send({type: "dance"})`, nil))

	// The page's Window: a plain window, sized as the first window for the
	// frame Chrome draws, with the page told and the memory kept.
	b.send(`{type: "display", mode: "window"}`)
	h = b.waitHost("the switch to a window", func(h pageHost, w cdpBounds) bool {
		return w.WindowState == stateNormal && h.Display == displayWindow && lastEvent(h) == displayWindow
	})

	if h.Kind != hostKind {
		t.Errorf("host after the switch %+v", h)
	}

	frame := b.frame()
	first := testFirst(frame)
	b.waitHost("the first window's size", func(_ pageHost, w cdpBounds) bool { return w.bounds() == first })

	inner := size{first.Width - frame.W, first.Height - frame.H}
	if ratio := float64(inner.W) / float64(inner.H); math.Abs(ratio-16.0/9) > 0.01 {
		t.Errorf("the first window's page is %v, not 16:9", inner)
	}

	b.waitMemory("the window remembered", windowMemory{Display: displayWindow, Bounds: &first})

	// A reload now starts in the mode in force.
	b.must(b.call(b.session, "Page.reload", nil, nil))
	b.waitLoaded()

	if h := b.host(); h.AtStart == nil || *h.AtStart != "windows-app/window" {
		t.Errorf("after a reload in a window the page started with %v, want windows-app/window", h.AtStart)
	}

	// Fullscreen again, then a window: the browser puts the window back.
	b.send(`{type: "display", mode: "fullscreen"}`)
	b.waitHost("the switch to fullscreen", func(h pageHost, w cdpBounds) bool {
		return w.WindowState == stateFullscreen && h.Display == displayFullscreen && lastEvent(h) == displayFullscreen
	})
	b.waitMemory("fullscreen remembered with the window's bounds", windowMemory{Display: displayFullscreen, Bounds: &first})

	b.send(`{type: "display", mode: "window"}`)
	b.waitHost("the window back where it was", func(h pageHost, w cdpBounds) bool {
		return w.WindowState == stateNormal && w.bounds() == first && h.Display == displayWindow
	})

	// Exit closes the browser, and the controller ends with it.
	b.send(`{type: "quit"}`)

	if err := b.controllerEnded(); err != nil {
		t.Errorf("the controller ended with %v after quit", err)
	}

	b.browserExited()
}

// The reader's own switches and resizes (F11, dragging the window) reach
// the page and the memory, through the poll.
func TestControllerNoticesChangesMadeOutsideIt(t *testing.T) {
	t.Parallel()

	kept := windowBounds{Left: 50, Top: 60, Width: 600, Height: 400}
	window := start{Bounds: kept}
	b := startChrome(t, window)

	if got := b.bounds(); got.WindowState != stateNormal || got.Width != kept.Width || got.Height != kept.Height {
		t.Fatalf("--window-size opened %+v, want a %dx%d window", got, kept.Width, kept.Height)
	}

	memory := windowMemory{Display: displayWindow, Bounds: &kept}
	b.runController(window, memory)

	h := b.waitHost("the host object", func(h pageHost, _ cdpBounds) bool { return h.Kind != "" })
	if h.Display != displayWindow || !reflect.DeepEqual(h.Events, []string{displayWindow}) {
		t.Errorf("host %+v, want a window, one event", h)
	}

	// A window the reader moves and resizes is remembered.
	moved := windowBounds{Left: 30, Top: 40, Width: 500, Height: 300}
	b.setWindow(map[string]any{"left": moved.Left, "top": moved.Top, "width": moved.Width, "height": moved.Height})
	b.waitMemory("the moved window remembered", windowMemory{Display: displayWindow, Bounds: &moved})

	// F11 in: the page hears, the memory keeps it.
	b.setWindow(map[string]any{"windowState": stateFullscreen})
	b.waitHost("the page told of fullscreen", func(h pageHost, _ cdpBounds) bool {
		return h.Display == displayFullscreen && lastEvent(h) == displayFullscreen
	})
	b.waitMemory("fullscreen remembered", windowMemory{Display: displayFullscreen, Bounds: &moved})

	// F11 out: the browser restores the window, and the controller leaves
	// it where the reader had it.
	b.setWindow(map[string]any{"windowState": stateNormal})
	b.waitHost("the page told of the window", func(h pageHost, w cdpBounds) bool {
		return h.Display == displayWindow && lastEvent(h) == displayWindow && w.bounds() == moved
	})
	b.waitMemory("the window remembered", windowMemory{Display: displayWindow, Bounds: &moved})

	if h := b.host(); !reflect.DeepEqual(h.Events, []string{displayWindow, displayFullscreen, displayWindow}) {
		t.Errorf("kinetic-host events %v, want one per change", h.Events)
	}

	// A maximized window is still a window, and its screen-filling bounds
	// are not the reader's to keep.
	b.setWindow(map[string]any{"windowState": stateMaximized})
	b.waitFor("the window maximized", func() (bool, string) {
		w := b.bounds()

		return w.WindowState == stateMaximized, fmt.Sprint(w)
	})
	time.Sleep(5 * 100 * time.Millisecond) // five polls

	if h, got := b.host(), loadMemory(b.memoryPath()); h.Display != displayWindow || len(h.Events) != 3 ||
		got.Bounds == nil || *got.Bounds != moved {
		t.Errorf("after maximizing: page %+v, memory %+v %+v; want no change", h, got, got.Bounds)
	}

	b.setWindow(map[string]any{"windowState": stateNormal})
	b.waitHost("the window restored", func(_ pageHost, w cdpBounds) bool {
		return w.WindowState == stateNormal && w.bounds() == moved
	})

	// Closing the browser ends the controller.
	_ = b.cmd.Process.Kill()

	if err := b.controllerEnded(); err != nil {
		t.Errorf("the controller ended with %v when the browser went", err)
	}
}

// A fullscreen start with a remembered window: the reader's F11 out puts
// the window where they left it, not where Chrome would.
func TestControllerPlacesAFullscreenStartsFirstWindowWhereTheReaderLeftIt(t *testing.T) {
	t.Parallel()

	fullscreen := start{Fullscreen: true}
	b := startChrome(t, fullscreen)
	kept := windowBounds{Left: 70, Top: 20, Width: 640, Height: 420}
	b.runController(fullscreen, windowMemory{Display: displayFullscreen, Bounds: &kept})
	b.waitHost("the host object", func(h pageHost, _ cdpBounds) bool { return h.Kind != "" })

	b.setWindow(map[string]any{"windowState": stateNormal})
	b.waitHost("the remembered window", func(h pageHost, w cdpBounds) bool {
		return w.WindowState == stateNormal && w.bounds() == kept && h.Display == displayWindow
	})
	b.waitMemory("the window remembered", windowMemory{Display: displayWindow, Bounds: &kept})
}

// The first window at launch takes an estimated frame; the controller
// measures the real one and corrects the size.
func TestControllerCorrectsTheFirstWindowToTheMeasuredFrame(t *testing.T) {
	t.Parallel()

	first := start{Bounds: testFirst(estimatedFrame), First: true}
	b := startChrome(t, first)
	b.runController(first, windowMemory{Display: displayWindow})
	b.waitHost("the host object", func(h pageHost, _ cdpBounds) bool { return h.Kind != "" })

	var frame size

	b.waitFor("the first window fitted to its frame", func() (bool, string) {
		frame = b.frame()
		got := b.bounds()

		return got.bounds() == testFirst(frame), fmt.Sprintf("%+v for frame %v", got, frame)
	})

	if frame == estimatedFrame {
		t.Logf("headless Chrome's frame is the estimate itself (%v); the correction was not needed", frame)
	}

	if b.bounds().bounds() == first.Bounds && frame != estimatedFrame {
		t.Errorf("the window kept its estimated size %+v", first.Bounds)
	}

	want := testFirst(frame)
	b.waitMemory("the fitted window remembered", windowMemory{Display: displayWindow, Bounds: &want})
}

// The game's window closing (its page gone) ends the browser too, so its
// DevTools port closes with the game, and the controller with it.
func TestControllerEndsTheBrowserWhenThePageCloses(t *testing.T) {
	t.Parallel()

	b := startChrome(t, start{Fullscreen: true})
	b.runController(start{Fullscreen: true}, windowMemory{Display: displayFullscreen})
	b.waitHost("the host object", func(h pageHost, _ cdpBounds) bool { return h.Kind != "" })

	var list struct {
		TargetInfos []targetInfo `json:"targetInfos"`
	}
	b.must(b.call("", "Target.getTargets", nil, &list))

	page, _ := pickPage(list.TargetInfos, b.pageURL)
	b.must(b.call("", "Target.closeTarget", map[string]any{"targetId": page.TargetID}, nil))

	if err := b.controllerEnded(); err != nil {
		t.Errorf("the controller ended with %v", err)
	}

	b.browserExited()
}

func TestWaitForDevTools(t *testing.T) {
	profile := t.TempDir()
	path := filepath.Join(profile, devToolsPortFile)

	// No browser connection in time: an error, and the game plays on.
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if _, err := waitForDevTools(ctx, profile, nil); err == nil {
		t.Error("waitForDevTools with no port file succeeded")
	}

	// A browser that exits first ends the wait at once.
	began := time.Now()

	if _, err := waitForDevTools(context.Background(), profile, func() bool { return false }); err == nil ||
		time.Since(began) > time.Second {
		t.Errorf("waitForDevTools for a gone browser = %v after %v", err, time.Since(began))
	}

	// A file written while waiting is read.
	go func() {
		time.Sleep(200 * time.Millisecond)

		_ = os.WriteFile(path, []byte("9222\n/devtools/browser/0b1c-2d3e\n"), 0o644)
	}()

	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()

	got, err := waitForDevTools(ctx2, profile, nil)
	if err != nil || got != "ws://127.0.0.1:9222/devtools/browser/0b1c-2d3e" {
		t.Errorf("waitForDevTools = %q, %v", got, err)
	}
}

func TestDevToolsURL(t *testing.T) {
	path := filepath.Join(t.TempDir(), devToolsPortFile)
	cases := map[string]string{
		"51234\n/devtools/browser/abc":        "ws://127.0.0.1:51234/devtools/browser/abc",
		"51234\r\n/devtools/browser/abc\r\n":  "ws://127.0.0.1:51234/devtools/browser/abc",
		"51234":                               "",
		"":                                    "",
		"0\n/devtools/browser/abc":            "",
		"70000\n/devtools/browser/abc":        "",
		"port\n/devtools/browser/abc":         "",
		"51234\n/devtools/page/abc":           "",
		"51234\n/devtools/browser/abc\nextra": "ws://127.0.0.1:51234/devtools/browser/abc",
	}
	for text, want := range cases {
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}

		got, err := devToolsURL(path)
		if want == "" && err == nil {
			t.Errorf("devToolsURL(%q) = %q, want an error", text, got)
		} else if want != "" && got != want {
			t.Errorf("devToolsURL(%q) = %q, %v; want %q", text, got, err, want)
		}
	}
}

func TestPickPage(t *testing.T) {
	game := "file:///C:/Games/Rainy%20Day/index.html"
	targets := []targetInfo{
		{TargetID: "w", Type: "service_worker", URL: "chrome-extension://x/sw.js"},
		{TargetID: "other", Type: "page", URL: "edge://newtab/"},
		{TargetID: "game", Type: "page", URL: game + "#resume"},
	}

	if got, ok := pickPage(targets, game); !ok || got.TargetID != "game" {
		t.Errorf("pickPage = %+v, %v; want the game's page", got, ok)
	}

	if got, ok := pickPage(targets, "file:///elsewhere.html"); !ok || got.TargetID != "other" {
		t.Errorf("pickPage with no match = %+v, %v; want the first page", got, ok)
	}

	if _, ok := pickPage(targets[:1], game); ok {
		t.Error("pickPage found a page among no pages")
	}
}

func TestDisplayFor(t *testing.T) {
	cases := map[string]string{
		stateFullscreen: displayFullscreen, stateNormal: displayWindow, stateMaximized: displayWindow,
		stateMinimized: "", "": "",
	}
	for state, want := range cases {
		got, ok := displayFor(state)
		if got != want || ok != (want != "") {
			t.Errorf("displayFor(%q) = %q, %v; want %q", state, got, ok, want)
		}
	}
}

func TestHostScriptNamesTheProtocol(t *testing.T) {
	script := hostScript(displayWindow)
	for _, want := range []string{
		`kind: "windows-app"`, `const mode = "window"`, `new Event("kinetic-host")`,
		`window.__kineticHostSend(JSON.stringify(message))`, `"kineticHost"`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("the host script lacks %s", want)
		}
	}
}
