package main

// The controller: while the game is open the exe steers its browser
// window over the DevTools connection, because a page cannot leave the
// fullscreen the browser started in. It gives the page the host object of
// the page-to-host protocol (apps/README.md), `window.kineticHost` with
// kind "windows-app", carries out the page's Exit and Fullscreen | Window,
// tells the page about the reader's own switches (F11), and keeps the
// window's mode and place in the memory file. Platform-neutral, so it is
// tested against headless Chrome on any OS (controller_test.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	// hostBinding is the function the exe adds to the page
	// (Runtime.addBinding); the host object's send calls it with the
	// message as JSON. Every frame gets it; the game has no frames.
	hostBinding = "__kineticHostSend"
	// hostSetter is where the host script keeps its display setter (not
	// enumerable), as the macOS bridge does.
	hostSetter = "__kineticHostSetDisplay"
	hostKind   = "windows-app"
)

// The browser's window states (Browser.Bounds.windowState).
const (
	stateNormal     = "normal"
	stateFullscreen = "fullscreen"
	stateMaximized  = "maximized"
	stateMinimized  = "minimized"
)

const (
	// callTimeout bounds one DevTools command.
	callTimeout = 10 * time.Second
	// pageWait is how long a new browser has to show the game's page.
	pageWait = 10 * time.Second
	// reattachWait is how long to look for the page again after the
	// exe's session to it ends.
	reattachWait = 2 * time.Second
	// switchWait bounds a fullscreen switch (animated on some systems).
	switchWait = 3 * time.Second
	// measureWait bounds the wait for a settled window to measure.
	measureWait = 2 * time.Second
	// browserCloseWait is how long the browser has to close after
	// Browser.close.
	browserCloseWait = 10 * time.Second
	// stepWait spaces the reads while waiting on the browser.
	stepWait = 50 * time.Millisecond
	// maxFrame is the largest plausible frame a window adds to its page,
	// in either direction; a measurement beyond it is a stale one.
	maxFrame = 200
)

// hostScript defines window.kineticHost for display, as apps/README.md
// specifies, and fires kinetic-host. Run in a page that already has the
// object (a late run, or a refresh), it only updates display, firing the
// event when display changes.
func hostScript(display string) string {
	mode, _ := json.Marshal(display)

	return `(() => {
  if (window !== window.top) return;
  const mode = ` + string(mode) + `;
  if (window.kineticHost) {
    if (typeof window.` + hostSetter + ` === "function") window.` + hostSetter + `(mode);
    return;
  }
  let display = mode;
  const host = Object.freeze({
    kind: "` + hostKind + `",
    get display() { return display; },
    send(message) { window.` + hostBinding + `(JSON.stringify(message)); },
  });
  Object.defineProperty(window, "kineticHost", { value: host });
  Object.defineProperty(window, "` + hostSetter + `", {
    value(next) {
      if (next === display) return;
      display = next;
      window.dispatchEvent(new Event("kinetic-host"));
    },
  });
  window.dispatchEvent(new Event("kinetic-host"));
})();`
}

// displayFor is the page's display for a window state; false for a
// minimized window, which changes nothing the page shows.
func displayFor(state string) (string, bool) {
	switch state {
	case stateFullscreen:
		return displayFullscreen, true
	case stateNormal, stateMaximized:
		return displayWindow, true
	default:
		return "", false
	}
}

// cdpBounds is a window's bounds and state as DevTools reports them.
type cdpBounds struct {
	Left        int    `json:"left"`
	Top         int    `json:"top"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	WindowState string `json:"windowState"`
}

func (b cdpBounds) bounds() windowBounds {
	return windowBounds{Left: b.Left, Top: b.Top, Width: b.Width, Height: b.Height}
}

// targetInfo is a DevTools target, as Target.getTargets lists it.
type targetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	URL      string `json:"url"`
}

// pickPage is the game's page among targets: the page at pageURL (any
// query or fragment aside), else the first page.
func pickPage(targets []targetInfo, pageURL string) (targetInfo, bool) {
	var first *targetInfo

	for i, t := range targets {
		if t.Type != "page" {
			continue
		}

		if first == nil {
			first = &targets[i]
		}

		bare, _, _ := strings.Cut(t.URL, "#")
		bare, _, _ = strings.Cut(bare, "?")

		if pageURL != "" && bare == pageURL {
			return t, true
		}
	}

	if first == nil {
		return targetInfo{}, false
	}

	return *first, true
}

// controllerConfig is what the controller needs from the launch.
type controllerConfig struct {
	// Endpoint is the browser's DevTools WebSocket URL.
	Endpoint string
	// PageURL is the game page's file URL.
	PageURL string
	// MemoryPath is the memory file; Memory what it held at launch.
	MemoryPath string
	Memory     windowMemory
	// Start is how the browser opened the window.
	Start start
	// Screen bounds every display, for checking remembered bounds.
	Screen rect
	// First is the first window's bounds for a window frame.
	First func(frame size) windowBounds
	// Poll is how often the window's state is read (default a second):
	// DevTools has no event for the reader's own switches.
	Poll time.Duration
	// Logf, if set, records what the controller does.
	Logf func(format string, args ...any)
}

type controller struct {
	cfg controllerConfig
	ctx context.Context
	cdp *cdpConn

	session  string
	windowID int
	// scriptID is the new-document script defining the host object.
	scriptID string
	// display is the mode the page has.
	display string
	memory  windowMemory
	// placed says the window has been a plain window at bounds of the
	// reader's or the exe's this session, which the browser restores
	// after fullscreen. A window that started fullscreen has not.
	placed bool
}

// runController steers the browser at cfg.Endpoint until it closes (nil)
// or ctx ends.
func runController(ctx context.Context, cfg controllerConfig) error {
	if cfg.Poll <= 0 {
		cfg.Poll = time.Second
	}

	if cfg.Logf == nil {
		cfg.Logf = func(string, ...any) {}
	}

	dialCtx, cancel := context.WithTimeout(ctx, callTimeout)
	conn, err := dialCDP(dialCtx, cfg.Endpoint)

	cancel()

	if err != nil {
		return err
	}

	defer func() { _ = conn.Close() }()

	c := &controller{cfg: cfg, ctx: ctx, cdp: conn, memory: cfg.Memory, placed: !cfg.Start.Fullscreen}

	b, err := c.attach(pageWait)
	if err != nil {
		return err
	}

	if cfg.Start.First && b.WindowState == stateNormal {
		c.fitFirst()
	}

	return c.loop()
}

// call sends a command with the controller's timeout.
func (c *controller) call(session, method string, params, result any) error {
	ctx, cancel := context.WithTimeout(c.ctx, callTimeout)
	defer cancel()

	return c.cdp.call(ctx, session, method, params, result)
}

// attach finds the game's page, attaches to it and gives it the host
// object; it returns the window's bounds then.
func (c *controller) attach(wait time.Duration) (cdpBounds, error) {
	target, err := c.findPage(wait)
	if err != nil {
		return cdpBounds{}, err
	}

	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err := c.call("", "Target.attachToTarget",
		map[string]any{"targetId": target.TargetID, "flatten": true}, &attached); err != nil {
		return cdpBounds{}, err
	}

	var window struct {
		WindowID int       `json:"windowId"`
		Bounds   cdpBounds `json:"bounds"`
	}
	if err := c.call("", "Browser.getWindowForTarget",
		map[string]any{"targetId": target.TargetID}, &window); err != nil {
		return cdpBounds{}, err
	}

	c.session, c.windowID = attached.SessionID, window.WindowID

	// Runtime.enable keeps the binding in every new document (a reload),
	// and Page.enable runs the new-document script there.
	for _, method := range []string{"Runtime.enable", "Page.enable"} {
		if err := c.call(c.session, method, nil, nil); err != nil {
			return cdpBounds{}, err
		}
	}

	if err := c.call(c.session, "Runtime.addBinding", map[string]any{"name": hostBinding}, nil); err != nil {
		return cdpBounds{}, err
	}

	// The mode the window is in; for a minimized one, the remembered mode.
	c.display = displayFullscreen
	if d, ok := displayFor(window.Bounds.WindowState); ok {
		c.display = d
	} else if c.memory.Display == displayWindow {
		c.display = displayWindow
	}

	c.scriptID = ""
	if err := c.refreshScript(); err != nil {
		return cdpBounds{}, err
	}

	// The page may have loaded before the exe attached: the protocol
	// allows the object to arrive late.
	c.evaluate(hostScript(c.display))
	c.cfg.Logf("attached to %s (%s), window %d %+v", target.URL, target.TargetID, c.windowID, window.Bounds)
	c.note(window.Bounds)

	return window.Bounds, nil
}

// findPage waits up to wait for the game's page target.
func (c *controller) findPage(wait time.Duration) (targetInfo, error) {
	deadline := time.Now().Add(wait)

	for {
		var list struct {
			TargetInfos []targetInfo `json:"targetInfos"`
		}

		err := c.call("", "Target.getTargets", nil, &list)
		if err == nil {
			if t, ok := pickPage(list.TargetInfos, c.cfg.PageURL); ok {
				return t, nil
			}
		}

		if c.cdp.Err() != nil {
			return targetInfo{}, c.cdp.Err()
		}

		if time.Now().After(deadline) {
			return targetInfo{}, errors.New("the browser shows no page")
		}

		if !c.sleep(2 * stepWait) {
			if err := c.cdp.Err(); err != nil {
				return targetInfo{}, err
			}

			return targetInfo{}, c.ctx.Err()
		}
	}
}

// sleep waits d unless ctx or the connection ends first.
func (c *controller) sleep(d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-c.ctx.Done():
		return false
	case <-c.cdp.Done():
		return false
	}
}

// loop handles the page's messages and polls the window until the browser
// closes.
func (c *controller) loop() error {
	tick := time.NewTicker(c.cfg.Poll)
	defer tick.Stop()

	for {
		select {
		case <-c.ctx.Done():
			return c.ctx.Err()
		case <-c.cdp.Done():
			c.cfg.Logf("the browser closed (%v)", c.cdp.Err())

			return nil
		case <-c.cdp.Events():
			for _, e := range c.cdp.takeEvents() {
				if c.handle(e) {
					return nil
				}
			}
		case <-tick.C:
			if b, err := c.windowBounds(); err == nil {
				c.note(b)
			}
		}
	}
}

// handle acts on one event; true when the controller is done.
func (c *controller) handle(e cdpEvent) bool {
	switch e.Method {
	case "Runtime.bindingCalled":
		var call struct {
			Name    string `json:"name"`
			Payload string `json:"payload"`
		}
		if e.SessionID != c.session || json.Unmarshal(e.Params, &call) != nil || call.Name != hostBinding {
			return false
		}

		var message struct {
			Type string `json:"type"`
			Mode string `json:"mode"`
		}
		if json.Unmarshal([]byte(call.Payload), &message) != nil {
			return false
		}

		c.cfg.Logf("the page sent %s", call.Payload)

		switch message.Type {
		case "quit":
			c.closeBrowser()

			return true
		case "display":
			if message.Mode == displayFullscreen || message.Mode == displayWindow {
				c.switchTo(message.Mode)
			}
		}
	case "Target.detachedFromTarget":
		var detached struct {
			SessionID string `json:"sessionId"`
		}
		if json.Unmarshal(e.Params, &detached) != nil || detached.SessionID != c.session {
			return false
		}

		// The game's window closed, or its page was swapped: find the
		// page again, or end the browser, so its DevTools port closes
		// with the game.
		c.cfg.Logf("the page's session ended")

		if _, err := c.attach(reattachWait); err != nil {
			c.closeBrowser()

			return true
		}
	}

	return false
}

// closeBrowser closes the browser and waits for its connection to end.
func (c *controller) closeBrowser() {
	if err := c.call("", "Browser.close", nil, nil); err != nil {
		c.cfg.Logf("Browser.close: %v", err)
	}

	select {
	case <-c.cdp.Done():
	case <-time.After(browserCloseWait):
	case <-c.ctx.Done():
	}
}

// windowBounds reads the window's bounds and state.
func (c *controller) windowBounds() (cdpBounds, error) {
	var got struct {
		Bounds cdpBounds `json:"bounds"`
	}
	err := c.call("", "Browser.getWindowBounds", map[string]any{"windowId": c.windowID}, &got)

	return got.Bounds, err
}

// setState asks for a window state.
func (c *controller) setState(state string) {
	if err := c.call("", "Browser.setWindowBounds", map[string]any{
		"windowId": c.windowID, "bounds": map[string]any{"windowState": state},
	}, nil); err != nil {
		c.cfg.Logf("setting the window %s: %v", state, err)
	}
}

// setBounds places a plain window.
func (c *controller) setBounds(b windowBounds) {
	if err := c.call("", "Browser.setWindowBounds",
		map[string]any{"windowId": c.windowID, "bounds": b}, nil); err != nil {
		c.cfg.Logf("placing the window at %+v: %v", b, err)
	}
}

// waitState reads the window until its state passes want, or switchWait
// passes; it returns the last bounds read.
func (c *controller) waitState(want func(string) bool) cdpBounds {
	deadline := time.Now().Add(switchWait)

	for {
		b, err := c.windowBounds()
		if err == nil && want(b.WindowState) {
			return b
		}

		if time.Now().After(deadline) || !c.sleep(stepWait) {
			return b
		}
	}
}

// switchTo carries out the page's Fullscreen | Window switch, then tells
// the page the mode the window is in.
func (c *controller) switchTo(mode string) {
	b, err := c.windowBounds()
	if err != nil {
		return
	}

	if mode == displayFullscreen && b.WindowState != stateFullscreen {
		if b.WindowState == stateNormal && c.placed {
			c.remember(b.bounds())
		}

		if b.WindowState == stateMinimized {
			// DevTools makes only a restored window fullscreen.
			c.setState(stateNormal)
			c.waitState(func(s string) bool { return s != stateMinimized })
		}

		c.setState(stateFullscreen)
		b = c.waitState(func(s string) bool { return s == stateFullscreen })
	} else if mode == displayWindow && b.WindowState != stateNormal {
		// A window's bounds can be set only once it is a plain window
		// again (note places it).
		c.setState(stateNormal)
		b = c.waitState(func(s string) bool { return s == stateNormal })
	}

	c.cfg.Logf("switched to %s: %+v", mode, b)
	c.note(b)
}

// note brings the page and the memory up to date with the window's bounds
// and state, placing a window that has just become a plain window for the
// first time this session.
func (c *controller) note(b cdpBounds) {
	d, ok := displayFor(b.WindowState)
	if !ok {
		return
	}

	if b.WindowState == stateNormal && !c.placed {
		c.place()

		if placed, err := c.windowBounds(); err == nil {
			b = placed
		}
	}

	c.showDisplay(d)

	if b.WindowState == stateNormal && c.placed {
		c.remember(b.bounds())
	}
}

// place puts a window that started fullscreen where the reader left it,
// or at the first window's place and size. The browser restores it there
// after any later fullscreen.
func (c *controller) place() {
	c.placed = true

	if m := c.memory.Bounds; m != nil && m.usable(c.cfg.Screen) {
		c.setBounds(*m)

		return
	}

	c.fitFirst()
}

// fitFirst sizes the window as the first window, for the frame measured
// around the page.
func (c *controller) fitFirst() {
	frame := c.measureFrame()

	b, err := c.windowBounds()
	if err != nil {
		return
	}

	if want := c.cfg.First(frame); want != b.bounds() {
		c.cfg.Logf("first window for frame %+v: %+v", frame, want)
		c.setBounds(want)
	}
}

// measureFrame is what the plain window adds around its page: its bounds
// less the page's inner size, read twice alike once the page has caught up
// with the window (a stale page reads implausibly). estimatedFrame when it
// cannot be read in time.
func (c *controller) measureFrame() size {
	deadline := time.Now().Add(measureWait)
	last := size{-1, -1}

	for {
		b, errB := c.windowBounds()
		inner, errI := c.innerSize()

		if errB == nil && errI == nil && b.WindowState == stateNormal && inner.W > 0 && inner.H > 0 {
			frame := size{b.Width - inner.W, b.Height - inner.H}
			plausible := frame.W >= 0 && frame.H >= 0 && frame.W <= maxFrame && frame.H <= maxFrame

			if plausible && frame == last {
				return frame
			}

			if plausible {
				last = frame
			} else {
				last = size{-1, -1}
			}
		}

		if time.Now().After(deadline) || !c.sleep(stepWait) {
			return estimatedFrame
		}
	}
}

// innerSize is the page's viewport in CSS pixels, which are DIPs at the
// page's usual zoom.
func (c *controller) innerSize() (size, error) {
	var got struct {
		Result struct {
			Value []int `json:"value"`
		} `json:"result"`
	}

	err := c.call(c.session, "Runtime.evaluate",
		map[string]any{"expression": "[innerWidth, innerHeight]", "returnByValue": true}, &got)
	if err != nil {
		return size{}, err
	}

	if len(got.Result.Value) != 2 {
		return size{}, errors.New("the page did not report its size")
	}

	return size{got.Result.Value[0], got.Result.Value[1]}, nil
}

// showDisplay tells the page its display, when it changed, and remembers
// it.
func (c *controller) showDisplay(d string) {
	if d != c.display {
		c.display = d
		// A reload from now on starts in d; then the page in front hears.
		if err := c.refreshScript(); err != nil {
			c.cfg.Logf("refreshing the host script: %v", err)
		}

		c.evaluate(hostScript(d))
		c.cfg.Logf("the page now shows %s", d)
	}

	if c.memory.Display != d {
		c.memory.Display = d
		c.save()
	}
}

// remember keeps a plain window's bounds.
func (c *controller) remember(b windowBounds) {
	if c.memory.Bounds == nil || *c.memory.Bounds != b {
		c.memory.Bounds = &b
		c.save()
	}
}

func (c *controller) save() {
	if c.cfg.MemoryPath == "" {
		return
	}

	if err := saveMemory(c.cfg.MemoryPath, c.memory); err != nil {
		c.cfg.Logf("saving %s: %v", c.cfg.MemoryPath, err)
	}
}

// refreshScript replaces the new-document script with one for the display
// now. The new one goes in before the old comes out, so a document begun
// in between runs both, and the second corrects the first.
func (c *controller) refreshScript() error {
	var added struct {
		Identifier string `json:"identifier"`
	}
	if err := c.call(c.session, "Page.addScriptToEvaluateOnNewDocument",
		map[string]any{"source": hostScript(c.display)}, &added); err != nil {
		return err
	}

	if c.scriptID != "" {
		if err := c.call(c.session, "Page.removeScriptToEvaluateOnNewDocument",
			map[string]any{"identifier": c.scriptID}, nil); err != nil {
			c.cfg.Logf("removing the old host script: %v", err)
		}
	}

	c.scriptID = added.Identifier

	return nil
}

// evaluate runs script in the page in front.
func (c *controller) evaluate(script string) {
	var got struct {
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}

	err := c.call(c.session, "Runtime.evaluate", map[string]any{"expression": script}, &got)
	if err == nil && got.ExceptionDetails != nil {
		err = fmt.Errorf("the script threw: %s", got.ExceptionDetails.Text)
	}

	if err != nil {
		c.cfg.Logf("running the host script: %v", err)
	}
}
