package main

import (
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
)

func TestHostScriptDefinesTheProtocolObject(t *testing.T) {
	script := hostScript(displayWindow, false)
	for _, want := range []string{
		`if (window !== window.top || !window.chrome || !window.chrome.webview) return;`,
		`const mode = "window";`,
		`kind: "windows-app",`,
		"send(message) {\n      window.chrome.webview.postMessage(message);\n    },",
		`Object.freeze(`,
		`Object.defineProperty(window, "kineticHost", { value: host });`,
		`Object.defineProperty(window, "__kineticHostSetDisplay", {`,
		`window.dispatchEvent(new Event("kinetic-host"));`,
	} {
		if !strings.Contains(script, want) {
			t.Errorf("hostScript lacks %q:\n%s", want, script)
		}
	}

	if got, want := setterScript(displayFullscreen),
		`window.__kineticHostSetDisplay && window.__kineticHostSetDisplay("fullscreen");`; got != want {
		t.Errorf("setterScript = %q, want %q", got, want)
	}

	if got := jsString(`a"b\c` + "\u2028"); got != `"a\"b\\c\u2028"` {
		t.Errorf("jsString = %s", got)
	}
}

// hostRun runs the host script in Node against a stand-in window (an
// EventTarget with window.chrome.webview) and reports what the page would
// see. The script text is passed in the environment.
const hostRun = `
const results = {};
function makeWindow(top, webview) {
  const w = new EventTarget();
  w.top = top ? w : {};
  if (webview) w.chrome = { webview: { postMessage: (m) => w.posted.push(m) } };
  w.posted = [];
  w.events = 0;
  w.addEventListener("kinetic-host", () => { w.events++; });
  return w;
}
const run = (w, source) => new Function("window", "Event", source)(w, Event);
const w = makeWindow(true, true);
run(w, process.env.HOST_FULLSCREEN);
const host = w.kineticHost;
results.created = { kind: host.kind, display: host.display, events: w.events,
  frozen: Object.isFrozen(host), enumerable: Object.keys(w).includes("kineticHost"),
  setterEnumerable: Object.keys(w).includes("__kineticHostSetDisplay") };
host.send({ type: "display", mode: "window" });
host.send({ type: "quit" });
results.posted = w.posted;
let threw = false;
try { w.kineticHost = null; } catch { threw = true; }
results.kept = w.kineticHost === host;
run(w, process.env.SET_WINDOW);
results.setWindow = { display: host.display, events: w.events };
run(w, process.env.SET_WINDOW);
results.setSame = { display: host.display, events: w.events };
run(w, process.env.HOST_FULLSCREEN);
results.overlap = { display: w.kineticHost.display, same: w.kineticHost === host, events: w.events };
const frame = makeWindow(false, true);
run(frame, process.env.HOST_FULLSCREEN);
results.frame = { host: frame.kineticHost === undefined, events: frame.events };
const bare = makeWindow(true, false);
run(bare, process.env.HOST_FULLSCREEN);
results.noWebview = { host: bare.kineticHost === undefined, events: bare.events };
console.log(JSON.stringify(results));
`

func TestHostScriptBehavesInAPage(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("needs Node to run the script")
	}

	cmd := exec.Command(node, "-e", hostRun)
	cmd.Env = append(cmd.Environ(),
		"HOST_FULLSCREEN="+hostScript(displayFullscreen, false),
		"SET_WINDOW="+setterScript(displayWindow))

	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}

	var got struct {
		Created struct {
			Kind, Display                        string
			Events                               int
			Frozen, Enumerable, SetterEnumerable bool
		}
		Posted    []hostMessage
		Kept      bool
		SetWindow struct {
			Display string
			Events  int
		}
		SetSame struct {
			Display string
			Events  int
		}
		Overlap struct {
			Display string
			Same    bool
			Events  int
		}
		Frame, NoWebview struct {
			Host   bool
			Events int
		}
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("node said %s: %v", out, err)
	}

	c := got.Created
	if c.Kind != hostKind || c.Display != displayFullscreen || c.Events != 1 || !c.Frozen || c.Enumerable ||
		c.SetterEnumerable {
		t.Errorf("the host as created = %+v, want windows-app, fullscreen, one event, frozen, not enumerable", c)
	}

	want := []hostMessage{{Type: "display", Mode: displayWindow}, {Type: "quit"}}
	if len(got.Posted) != 2 || got.Posted[0] != want[0] || got.Posted[1] != want[1] {
		t.Errorf("send posted %+v, want %+v", got.Posted, want)
	}

	if !got.Kept {
		t.Error("the page could replace window.kineticHost")
	}

	if got.SetWindow.Display != displayWindow || got.SetWindow.Events != 2 {
		t.Errorf("the setter to window gave %+v, want window and a second event", got.SetWindow)
	}

	if got.SetSame.Display != displayWindow || got.SetSame.Events != 2 {
		t.Errorf("the setter to the same mode gave %+v, want no new event", got.SetSame)
	}

	if got.Overlap.Display != displayFullscreen || !got.Overlap.Same || got.Overlap.Events != 3 {
		t.Errorf("a second creation script gave %+v, want the same host, fullscreen, a third event", got.Overlap)
	}

	if !got.Frame.Host || got.Frame.Events != 0 || !got.NoWebview.Host || got.NoWebview.Events != 0 {
		t.Errorf("a frame gave %+v and a page without the web view %+v, want no host and no event",
			got.Frame, got.NoWebview)
	}
}

func TestParseMessage(t *testing.T) {
	good := map[string]hostMessage{
		`{"type":"quit"}`:                              {Type: "quit"},
		`{"type":"quit","mode":"window"}`:              {Type: "quit"},
		`{"type":"display","mode":"window"}`:           {Type: "display", Mode: displayWindow},
		`{"mode":"fullscreen","type":"display"}`:       {Type: "display", Mode: displayFullscreen},
		`{"type":"display","mode":"window","x":1}`:     {Type: "display", Mode: displayWindow},
		`{"type":"display","mode":"window","ui":"de"}`: {Type: "display", Mode: displayWindow},
		`{"type":"language","ui":"de","dir":"ltr","title":"Die Reise"}`: {
			Type: "language", UI: "de", Dir: "ltr", Title: "Die Reise",
		},
		`{"type":"language","ui":"ar","dir":"rtl"}`: {Type: "language", UI: "ar", Dir: "rtl"},
		`{"type":"language","ui":"ja","dir":"up"}`:  {Type: "language", UI: "ja", Dir: "ltr"},
	}
	for text, want := range good {
		if got, ok := parseMessage(text); !ok || got != want {
			t.Errorf("parseMessage(%s) = %+v, %v; want %+v", text, got, ok, want)
		}
	}

	for _, text := range []string{
		``, `{`, `"quit"`, `null`, `[]`, `{}`, `{"type":"display"}`, `{"type":"display","mode":"maximized"}`,
		`{"type":"close"}`, `{"type":7}`, `{"type":"QUIT"}`,
		`{"type":"language"}`, `{"type":"language","ui":""}`, `{"type":"language","ui":7}`,
		`{"type":"language","ui":"en","title":7}`,
	} {
		if got, ok := parseMessage(text); ok {
			t.Errorf("parseMessage(%s) = %+v, want refused", text, got)
		}
	}
}

func TestLanguageTitle(t *testing.T) {
	cases := []struct {
		title, want string
	}{
		{"Die Reise", "Die Reise"},
		{"  الرحلة  ", "الرحلة"},
		{"", "Journey"},
		{"   ", "Journey"},
		{"Bad\x00Title", "Journey"},
	}
	for _, c := range cases {
		if got := languageTitle(hostMessage{Type: "language", UI: "de", Title: c.title}, "Journey"); got != c.want {
			t.Errorf("languageTitle(%q) = %q, want %q", c.title, got, c.want)
		}
	}
}

func TestOnlyTheGamesPageSpeaksForIt(t *testing.T) {
	page := fileURL(`D:\Games\Rainy Day (Two)\index.html`)
	accepted := []string{
		page,
		page + "#again",
		page + "?x=1#y",
		"file:///D:/Games/Rainy%20Day%20(Two)/index.html",
		"file:///d:/games/rainy%20day%20(two)/INDEX.HTML",
		"file://localhost/D:/Games/Rainy%20Day%20(Two)/index.html",
	}
	for _, source := range accepted {
		if !fromGame(source, page) {
			t.Errorf("fromGame(%q) refused", source)
		}
	}

	refused := []string{
		"", "about:blank", "data:text/html,<p>", "http://example.com/index.html",
		"https://localhost/D:/Games/Rainy%20Day%20(Two)/index.html",
		"file:///D:/Games/Rainy%20Day%20(Two)/other.html",
		"file:///D:/Games/Rainy%20Day%20(Two)/",
		"file:///D:/Games/Rainy%20Day/index.html",
		"file://nas/D:/Games/Rainy%20Day%20(Two)/index.html",
		"%zz",
	}
	for _, source := range refused {
		if fromGame(source, page) {
			t.Errorf("fromGame(%q) accepted", source)
		}
	}

	unc := fileURL(`\\nas\games\Rainy Day\index.html`)
	if !fromGame("file://NAS/games/Rainy%20Day/index.html", unc) || fromGame("file://other/games/Rainy%20Day/index.html", unc) {
		t.Error("a page on a network share is matched by its host and path")
	}
}

func TestAcceleratorKeys(t *testing.T) {
	const repeat = repeatBit | 1

	cases := []struct {
		name      string
		kind, key uint32
		lParam    int32
		ctrl, alt bool
		want      keyAction
	}{
		{"F11", keyDown, vkF11, 1, false, false, keyToggle},
		{"Ctrl+F11", keyDown, vkF11, 1, true, false, keyToggle},
		{"F11 held", keyDown, vkF11, repeat, false, false, keySwallow},
		{"F11 released", 1, vkF11, 1, false, false, keyPass},
		{"F5", keyDown, vkF5, 1, false, false, keyReload},
		{"Ctrl+F5", keyDown, vkF5, 1, true, false, keyReload},
		{"F5 held", keyDown, vkF5, repeat, false, false, keySwallow},
		{"Ctrl+R", keyDown, vkR, 1, true, false, keyReload},
		{"Ctrl+R held", keyDown, vkR, repeat, true, false, keySwallow},
		{"R alone is the page's", keyDown, vkR, 1, false, false, keyPass},
		{"Alt+F5 is not reload", 2, vkF5, 1, false, true, keyPass},
		{"Alt+F11", keyDown, vkF11, 1, false, true, keyPass},
		{"Esc is the page's", keyDown, 0x1B, 1, false, false, keyPass},
		{"held Esc is the page's", keyDown, 0x1B, repeat, false, false, keyPass},
		{"Tab", keyDown, 0x09, 1, false, false, keyPass},
		{"Ctrl+F (find) is the page's", keyDown, 0x46, 1, true, false, keyPass},
		{"F12 (dev tools) is the page's", keyDown, 0x7B, 1, false, false, keyPass},
		{"Alt+F4", 2, 0x73, 1, false, true, keyPass},
	}
	for _, c := range cases {
		if got := acceleratorAction(c.kind, c.key, c.lParam, c.ctrl, c.alt); got != c.want {
			t.Errorf("%s: acceleratorAction = %d, want %d", c.name, got, c.want)
		}
	}
}

func TestDownloadName(t *testing.T) {
	cases := map[string]string{
		`C:\Users\Zoë\Downloads\rainy-day-progress.json`:      "rainy-day-progress.json",
		`C:\Users\Zoë\Downloads\rainy-day-progress (1).json`:  "rainy-day-progress.json",
		`C:\Users\Zoë\Downloads\rainy-day-progress (12).json`: "rainy-day-progress.json",
		`C:/x/notes (draft).txt`:                              "notes (draft).txt",
		`C:\x\archive.tar.gz`:                                 "archive.tar.gz",
		`C:\x\README`:                                         "README",
		`C:\x\.json`:                                          ".json",
		`rainy-day-progress.json`:                             "rainy-day-progress.json",
		`C:\x\`:                                               fallbackDownload,
		``:                                                    fallbackDownload,
		`C:\x\ (1)`:                                           " (1)",
	}
	for suggested, want := range cases {
		if got := downloadName(suggested); got != want {
			t.Errorf("downloadName(%q) = %q, want %q", suggested, got, want)
		}
	}
}

func TestFreeNameNeverReplacesAFile(t *testing.T) {
	dir := `C:\Users\Zoë\Downloads`
	taken := map[string]bool{}
	isTaken := func(path string) bool { return taken[strings.ToLower(path)] }

	var got []string

	for range 4 {
		path := freeName(dir, "rainy-day-progress.json", isTaken)
		got = append(got, path)
		taken[strings.ToLower(path)] = true
	}

	want := []string{
		dir + `\rainy-day-progress.json`,
		dir + `\rainy-day-progress (2).json`,
		dir + `\rainy-day-progress (3).json`,
		dir + `\rainy-day-progress (4).json`,
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("four downloads went to\n%q\nwant\n%q", got, want)
	}

	if got := freeName(dir, "x.json", func(string) bool { return true }); got != dir+`\x (9999).json` {
		t.Errorf("with every name taken freeName = %q, want it to stop at (9999)", got)
	}

	if got := freeName(dir+`\`, "README", func(p string) bool { return p == dir+`\README` }); got != dir+`\README (2)` {
		t.Errorf("a name with no extension = %q", got)
	}
}

func TestWindowTitleFollowsThePage(t *testing.T) {
	cases := map[string]string{
		"Rainy Day":                         "Rainy Day",
		"Kinetic":                           "Kinetic",
		"":                                  "Game",
		"  ":                                "Game",
		"file:///C:/Games/Rainy/index.html": "Game",
		"FILE:///C:/x.html":                 "Game",
	}
	for page, want := range cases {
		if got := windowTitle(page, "Game"); got != want {
			t.Errorf("windowTitle(%q) = %q, want %q", page, got, want)
		}
	}
}

func TestHresult(t *testing.T) {
	if got := hresult(-2147024894); got != "0x80070002" {
		t.Errorf("hresult = %s", got)
	}

	if got := hresult(0); got != "0x00000000" {
		t.Errorf("hresult(0) = %s", got)
	}
}
