package main

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestVoiceSettingsFromTheEnvironment(t *testing.T) {
	env := func(values map[string]string) func(string) string {
		return func(key string) string { return values[key] }
	}

	got := voiceSettingsFrom(env(map[string]string{"LOCALAPPDATA": `C:\Users\r\AppData\Local`}), "/work")
	if want := (voiceSettings{Root: `C:\Users\r\AppData\Local\Kinetic\Voice`}); got != want {
		t.Errorf("default settings = %+v, want %+v", got, want)
	}

	if got := voiceSettingsFrom(env(nil), "/work"); got.Root != "" {
		t.Errorf("with no LOCALAPPDATA the voice folder is %q, want none", got.Root)
	}

	got = voiceSettingsFrom(env(map[string]string{
		"LOCALAPPDATA":                `C:\Local`,
		"KINETIC_VOICE_DIR":           "voice",
		"KINETIC_VOICE_DOWNLOAD_BASE": "http://127.0.0.1:9/files/",
		"KINETIC_VOICE_LOCK":          "locks/test.json",
		"KINETIC_VOICE_PYTHON":        "/usr/bin/python3",
		"KINETIC_VOICE_HELPER":        "python3 helper.py --engine fake",
	}), "/work")
	want := voiceSettings{
		Root:          filepath.Join("/work", "voice"),
		DownloadBase:  "http://127.0.0.1:9/files/",
		LockFile:      filepath.Join("/work", "locks", "test.json"),
		Python:        "/usr/bin/python3",
		HelperCommand: "python3 helper.py --engine fake",
	}
	if got != want {
		t.Errorf("overridden settings = %+v, want %+v", got, want)
	}
}

func TestRedirectURL(t *testing.T) {
	for _, c := range []struct{ url, base, want string }{
		{"https://github.com/a/b.tar.gz", "", "https://github.com/a/b.tar.gz"},
		{"https://github.com/a/b.tar.gz", "http://127.0.0.1:8000", "http://127.0.0.1:8000/github.com/a/b.tar.gz"},
		{"https://huggingface.co", "http://h:1/x/", "http://h:1/x/huggingface.co"},
		{"no-scheme", "http://h:1", "no-scheme"},
	} {
		if got := redirectURL(c.url, c.base); got != c.want {
			t.Errorf("redirectURL(%q, %q) = %q, want %q", c.url, c.base, got, c.want)
		}
	}
}

const sampleLock = `{
  "id": "windows-x64-1",
  "python": {"version": "3.12.16", "release": "20261110",
    "url": "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz",
    "sha256": "abc123", "size": 47438699},
  "wheels": [
    {"name": "torch", "url": "https://download.pytorch.org/whl/cpu/torch.whl", "sha256": "1", "size": 200},
    {"name": "torch", "url": "https://download.pytorch.org/whl/cu128/torch.whl", "sha256": "2", "size": 2500},
    {"name": "numpy", "url": "https://files.pythonhosted.org/numpy.whl", "sha256": "3", "size": 30}
  ],
  "model": [
    {"repo": "ResembleAI/chatterbox", "revision": "r", "path": "t3.safetensors", "sha256": "4", "size": 1000},
    {"repo": "ResembleAI/chatterbox", "revision": "r", "path": "s3gen.pt", "sha256": "5", "size": 400}
  ],
  "engine": {"id": "chatterbox-torch", "cfgWeight": 0.5}
}`

func TestParseVoiceLock(t *testing.T) {
	lock, err := parseVoiceLock([]byte(sampleLock), "")
	if err != nil {
		t.Fatal(err)
	}

	if lock.ID != "windows-x64-1" || lock.PythonSHA256 != "abc123" || lock.PythonSize != 47438699 ||
		!strings.HasSuffix(lock.PythonURL, "x86_64-pc-windows-msvc-install_only.tar.gz") {
		t.Errorf("lock = %+v", lock)
	}

	// One wheel a package, the largest where a package has variants (the
	// helper picks one, which the app cannot know before it runs), and
	// every model file.
	if want := int64(2500 + 30 + 1000 + 400); lock.HelperBytes != want {
		t.Errorf("HelperBytes = %d, want %d", lock.HelperBytes, want)
	}

	if string(lock.HelperText) != sampleLock {
		t.Error("without a download base the helper gets the lock as it is")
	}

	for _, bad := range []string{
		``, `[]`, `{"id": "x"}`,
		`{"id": "x", "python": {"url": "u", "sha256": "s"}, "wheels": [], "model": []}`,
		`{"id": "x", "python": {"url": "u", "sha256": "s", "size": 1}, "model": []}`,
		`{"id": 3, "python": {"url": "u", "sha256": "s", "size": 1}, "wheels": [], "model": []}`,
	} {
		if _, err := parseVoiceLock([]byte(bad), ""); err == nil || err.Error() != "The voice lock file is not readable." {
			t.Errorf("parseVoiceLock(%s) = %v, want not readable", bad, err)
		}
	}
}

func TestTheLockUnderADownloadBaseSendsEveryDownloadThere(t *testing.T) {
	lock, err := parseVoiceLock([]byte(sampleLock), "http://127.0.0.1:8000/")
	if err != nil {
		t.Fatal(err)
	}

	const base = "http://127.0.0.1:8000/"
	if lock.PythonURL != base+"github.com/astral-sh/python-build-standalone/releases/download/20261110/"+
		"cpython-3.12.16%2B20261110-x86_64-pc-windows-msvc-install_only.tar.gz" {
		t.Errorf("PythonURL = %s", lock.PythonURL)
	}

	var helper struct {
		ID           string
		Python       struct{ URL string }
		Wheels       []struct{ URL string }
		ModelBaseURL string `json:"modelBaseUrl"`
		Model        []struct{ Size int64 }
		Engine       map[string]any
	}
	if err := json.Unmarshal(lock.HelperText, &helper); err != nil {
		t.Fatal(err)
	}

	if helper.ID != "windows-x64-1" || helper.Python.URL != lock.PythonURL ||
		helper.Wheels[0].URL != base+"download.pytorch.org/whl/cpu/torch.whl" ||
		helper.Wheels[2].URL != base+"files.pythonhosted.org/numpy.whl" ||
		helper.ModelBaseURL != base+"huggingface.co" || len(helper.Model) != 2 || helper.Model[0].Size != 1000 ||
		helper.Engine["cfgWeight"] != 0.5 {
		t.Errorf("the helper's lock = %+v", helper)
	}
}

func TestParseVoiceMessage(t *testing.T) {
	got, ok := parseVoiceMessage(`{"type":"voice","op":"speak","id":12,"voiceId":"v","text":"Hello","priority":3,` +
		`"stream":true}`)
	if !ok || got["op"] != "speak" || got["text"] != "Hello" || got["stream"] != true {
		t.Fatalf("parseVoiceMessage = %v, %v", got, ok)
	}

	// Numbers keep their exact text, so the page's ids come back as sent.
	if id, _ := json.Marshal(got["id"]); string(id) != "12" {
		t.Errorf("id = %s", id)
	}

	for _, text := range []string{``, `{`, `[]`, `null`, `{"type":"quit"}`, `{"type":"voice"}`, `{"type":"voice","op":3}`} {
		if got, ok := parseVoiceMessage(text); ok {
			t.Errorf("parseVoiceMessage(%s) = %v, want refused", text, got)
		}
	}
}

func TestVoiceScriptCallsTheHostScriptsDeliverer(t *testing.T) {
	got := voiceScript(map[string]any{"event": "status", "state": "absent", "message": "a</script>\u2028"})
	want := `window.__kineticHostVoice && window.__kineticHostVoice(` +
		`{"event":"status","message":"a</script>\u2028","state":"absent"});`

	if got != want {
		t.Errorf("voiceScript = %s\nwant %s", got, want)
	}
}

func TestTheHostScriptOffersVoiceOnlyWithAVoiceHost(t *testing.T) {
	if s := hostScript(displayWindow, false); strings.Contains(s, "voice") {
		t.Errorf("a host without voice mentions it:\n%s", s)
	}

	if s := hostScript(displayWindow, true); !strings.Contains(s, "voice: true,") {
		t.Errorf("a voice host's script lacks voice: true:\n%s", s)
	}
}

// voiceRun runs the voice host script in Node against a stand-in window
// and reports what the page's receiver saw.
const voiceRun = `
const w = new EventTarget();
w.top = w;
w.posted = [];
w.chrome = { webview: { postMessage: (m) => w.posted.push({ m, seen: w.seen.length }) } };
w.seen = [];
const run = (source) => new Function("window", "Event", source)(w, Event);
const results = {};
run(process.env.HOST);
const host = w.kineticHost;
results.voice = host.voice;
results.enumerable = Object.keys(w).includes("__kineticHostVoice");
// Before the page has its receiver: the latest status is kept, the rest
// dropped.
run(process.env.STATUS_ABSENT);
run(process.env.SPEECH);
run(process.env.STATUS_INSTALLING);
w.__kineticVoice = (e) => w.seen.push(e);
results.beforeSend = w.seen.length;
// The page's next voice message gets the held status first.
host.send({ type: "voice", op: "status" });
results.afterSend = w.seen.slice();
host.send({ type: "voice", op: "status" });
results.heldOnce = w.seen.length;
run(process.env.SPEECH);
results.posted = w.posted;
results.seen = w.seen;
// A receiver that throws still received its event.
w.__kineticVoice = () => { throw new Error("page bug"); };
let threw = false;
try { run(process.env.STATUS_ABSENT); } catch { threw = true; }
results.threw = threw;
delete w.__kineticVoice;
run(process.env.STATUS_ABSENT);
w.__kineticVoice = (e) => w.seen.push(e);
host.send({ type: "display", mode: "window" });
results.notOnDisplay = w.seen.length;
console.log(JSON.stringify(results));
`

func TestTheVoiceHostScriptBehavesInAPage(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("needs Node to run the script")
	}

	cmd := exec.Command(node, "-e", voiceRun)
	cmd.Env = append(cmd.Environ(),
		"HOST="+hostScript(displayWindow, true),
		"STATUS_ABSENT="+voiceScript(map[string]any{"event": "status", "state": "absent"}),
		"STATUS_INSTALLING="+voiceScript(map[string]any{"event": "status", "state": "installing"}),
		"SPEECH="+voiceScript(map[string]any{"event": "speech", "id": 4}))

	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}

	type event struct {
		Event, State string
		ID           int
	}

	var got struct {
		Voice, Enumerable    bool
		BeforeSend, HeldOnce int
		AfterSend, Seen      []event
		Posted               []struct {
			M    map[string]any
			Seen int
		}
		Threw        bool
		NotOnDisplay int
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("node said %s: %v", out, err)
	}

	if !got.Voice || got.Enumerable {
		t.Errorf("voice = %v, deliverer enumerable = %v; want voice and a hidden deliverer", got.Voice, got.Enumerable)
	}

	if got.BeforeSend != 0 || len(got.AfterSend) != 1 || got.AfterSend[0] != (event{Event: "status", State: "installing"}) {
		t.Errorf("held status: %d before the page's message, then %+v; want the latest status alone",
			got.BeforeSend, got.AfterSend)
	}

	// The held status reached the page before its message went to the exe.
	if len(got.Posted) != 3 || got.Posted[0].Seen != 1 || got.Posted[0].M["op"] != "status" || got.Posted[2].M["type"] != "display" {
		t.Errorf("posted %+v", got.Posted)
	}

	if got.HeldOnce != 1 || len(got.Seen) != 2 || got.Seen[1] != (event{Event: "speech", ID: 4}) {
		t.Errorf("seen %+v (held sent %d times)", got.Seen, got.HeldOnce)
	}

	if got.Threw {
		t.Error("a receiver's exception escaped the deliverer")
	}

	// The status held after the throwing receiver went is not sent with a
	// display message: only a voice message flushes it.
	if got.NotOnDisplay != 2 {
		t.Errorf("a display message delivered the held status (%d seen)", got.NotOnDisplay)
	}
}
