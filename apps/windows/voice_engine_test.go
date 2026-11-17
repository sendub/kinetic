package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"testing/fstest"
	"time"
)

// The engine's tests run the repo's own helper (apps/voice) with its fake
// engine, under the repo's .venv Python, against a local server standing
// in for GitHub and Hugging Face.

var repoRoot, _ = filepath.Abs(filepath.Join("..", ".."))

func venvPython(t *testing.T) string {
	t.Helper()

	python := filepath.Join(repoRoot, ".venv", "bin", "python")
	if _, err := os.Stat(python); err != nil {
		t.Skip("needs the repo's .venv Python to run the helper")
	}

	return python
}

// helperFiles is the embedded helper as the build lays it out: the
// package's Python files under kinetic_voice/, and the lock.
func helperFiles(t *testing.T, lock []byte) fstest.MapFS {
	t.Helper()

	files := fstest.MapFS{}

	paths, err := filepath.Glob(filepath.Join(repoRoot, "apps", "voice", "kinetic_voice", "*.py"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no helper files: %v", err)
	}

	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}

		files["kinetic_voice/"+filepath.Base(p)] = &fstest.MapFile{Data: data}
	}

	if lock != nil {
		files[voiceLockName] = &fstest.MapFile{Data: lock}
	}

	return files
}

// testPlatform stands in for Windows: free space as set, and the shell for
// a helper command.
type testPlatform struct {
	free    int64
	hasFree bool
	// smi is what nvidia-smi prints (an RTX 5090 on driver 572.83 when
	// empty); smiErr makes it fail; smiCalls counts the runs.
	smi      string
	smiErr   error
	smiCalls *atomic.Int32
}

func (p testPlatform) nvidiaSmi() (string, error) {
	if p.smiCalls != nil {
		p.smiCalls.Add(1)
	}

	switch {
	case p.smiErr != nil:
		return "", p.smiErr
	case p.smi != "":
		return p.smi, nil
	}

	return "NVIDIA GeForce RTX 5090, 572.83\n", nil
}

func (p testPlatform) freeBytes(string) (int64, bool) { return p.free, p.hasFree }
func (testPlatform) prepare(*exec.Cmd)                {}
func (testPlatform) shell(command string) *exec.Cmd {
	return exec.Command("/bin/sh", "-c", "exec "+command)
}

// voiceServer serves a Python archive and one model file under their
// real hosts' paths, as a download base, counting requests per path.
type voiceServer struct {
	*httptest.Server

	mu       sync.Mutex
	files    map[string][]byte
	requests map[string]int
	ranges   map[string][]string
	// slow, when set, sends the archive's first response in pieces.
	slow atomic.Bool
}

const (
	archivePath = "/github.com/astral-sh/python-build-standalone/releases/download/20261110/python.tar.gz"
	modelPath   = "/huggingface.co/test/voice/resolve/rev1/model.bin"
)

func newVoiceServer(t *testing.T, archive, model []byte) *voiceServer {
	s := &voiceServer{
		files:    map[string][]byte{archivePath: archive, modelPath: model},
		requests: map[string]int{},
		ranges:   map[string][]string{},
	}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)

	return s
}

func (s *voiceServer) serve(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	data, ok := s.files[r.URL.Path]
	s.requests[r.URL.Path]++
	first := s.requests[r.URL.Path] == 1
	s.ranges[r.URL.Path] = append(s.ranges[r.URL.Path], r.Header.Get("Range"))
	s.mu.Unlock()

	if !ok {
		http.NotFound(w, r)

		return
	}

	if s.slow.Load() && first && r.URL.Path == archivePath {
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))

		for i := 0; i < len(data); i += 16384 {
			if _, err := w.Write(data[i:min(i+16384, len(data))]); err != nil {
				return
			}

			w.(http.Flusher).Flush()
			time.Sleep(20 * time.Millisecond)
		}

		return
	}

	http.ServeContent(w, r, "f", time.Time{}, bytes.NewReader(data))
}

func (s *voiceServer) count(path string) int {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.requests[path]
}

// testLock is a lock naming the server's files, with the fake engine.
func testLock(archive, model []byte) []byte {
	lock := map[string]any{
		"id": "windows-x64-test-1",
		"python": map[string]any{
			"version": "3.12.16", "release": "20261110",
			"url":    "https://github.com" + strings.TrimPrefix(archivePath, "/github.com"),
			"sha256": sha256Text(archive), "size": len(archive),
		},
		"wheels":       []any{},
		"modelBaseUrl": "https://huggingface.co",
		"model": []any{map[string]any{
			"repo": "test/voice", "revision": "rev1", "path": "model.bin",
			"sha256": sha256Text(model), "size": len(model),
		}},
		"engine": map[string]any{"id": "fake"},
	}
	data, _ := json.MarshalIndent(lock, "", " ")

	return data
}

// harness drives one engine and collects its events as the page gets them
// (through JSON).
type harness struct {
	t      *testing.T
	e      *voiceEngine
	events chan map[string]any
	seen   []map[string]any
	root   string
}

func newHarness(t *testing.T, s voiceSettings, files fs.FS, plat voicePlatform) *harness {
	h := &harness{t: t, events: make(chan map[string]any, 10000), root: s.Root}
	h.e = newVoiceEngine(s, files, plat, func(event map[string]any) {
		data, err := json.Marshal(event)
		if err != nil {
			t.Errorf("an event is not JSON: %v", err)

			return
		}

		var back map[string]any
		_ = json.Unmarshal(data, &back)
		h.events <- back
	})
	t.Cleanup(h.e.shutdown)

	return h
}

func (h *harness) send(text string) {
	h.t.Helper()

	msg, ok := parseVoiceMessage(text)
	if !ok {
		h.t.Fatalf("not a voice message: %s", text)
	}

	h.e.receive(msg)
}

// waitFor returns the first event, from now on, that match accepts.
func (h *harness) waitFor(what string, match func(map[string]any) bool) map[string]any {
	h.t.Helper()

	deadline := time.After(60 * time.Second)

	for {
		select {
		case e := <-h.events:
			h.seen = append(h.seen, e)
			if match(e) {
				return e
			}
		case <-deadline:
			h.t.Fatalf("no %s; events: %v", what, h.seen)
		}
	}
}

// expect returns the first event so far that match accepts, else the next
// one to come.
func (h *harness) expect(what string, match func(map[string]any) bool) map[string]any {
	h.t.Helper()

	for _, e := range h.seen {
		if match(e) {
			return e
		}
	}

	return h.waitFor(what, match)
}

func isStatus(state string) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["event"] == "status" && e["state"] == state }
}

func isEvent(event string, id float64) func(map[string]any) bool {
	return func(e map[string]any) bool { return e["event"] == event && e["id"] == id }
}

// quiet reports the events that come within d.
func (h *harness) quiet(d time.Duration) []map[string]any {
	var got []map[string]any

	deadline := time.After(d)

	for {
		select {
		case e := <-h.events:
			h.seen = append(h.seen, e)
			got = append(got, e)
		case <-deadline:
			return got
		}
	}
}

// wavClip is a short silent WAV, a reference clip.
func wavClip() string {
	var b bytes.Buffer

	samples := 2400
	b.WriteString("RIFF")
	_ = binary.Write(&b, binary.LittleEndian, uint32(36+samples*2))
	b.WriteString("WAVEfmt ")
	_ = binary.Write(&b, binary.LittleEndian, []any{uint32(16), uint16(1), uint16(1), uint32(24000), uint32(48000),
		uint16(2), uint16(16)})
	b.WriteString("data")
	_ = binary.Write(&b, binary.LittleEndian, uint32(samples*2))
	b.Write(make([]byte, samples*2))

	return base64.StdEncoding.EncodeToString(b.Bytes())
}

// fakePython is an install_only-shaped archive whose python.exe runs the
// repo's .venv Python, plus a large file so the download takes a while
// when the server is slow.
func fakePython(t *testing.T, python string) []byte {
	noise := make([]byte, 600000)
	_, _ = rand.NewChaCha8([32]byte{7}).Read(noise)

	return makeArchive(t, []tarEntry{
		{name: "python/python.exe", body: "#!/bin/sh\nexec \"" + python + "\" \"$@\"\n", mode: 0o755},
		{name: "python/Lib/big.bin", body: string(noise)},
	})
}

func TestVoiceStatusBeforeAnyInstall(t *testing.T) {
	archive, model := []byte("archive"), []byte("model!")
	lock := testLock(archive, model)
	root := filepath.Join(t.TempDir(), "Voice")
	h := newHarness(t, voiceSettings{Root: root}, helperFiles(t, lock), testPlatform{})

	h.send(`{"type":"voice","op":"status"}`)
	e := h.waitFor("status", isStatus("absent"))

	if e["downloadBytes"] != float64(len(archive)+len(model)) || e["done"] != nil || e["message"] != nil {
		t.Errorf("status = %v, want absent with the Python archive and the model file", e)
	}

	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Error("a status made the voice folder")
	}

	// Lines before the install.
	h.send(`{"type":"voice","op":"speak","id":5,"voiceId":"v","text":"Hi"}`)
	e = h.waitFor("an error", isEvent("error", 5))

	if e["code"] != "not-installed" || e["message"] != "Spoken lines are not installed." {
		t.Errorf("speak before the install = %v", e)
	}

	h.send(`{"type":"voice","op":"sing","id":"x"}`)
	e = h.waitFor("an unknown op", func(e map[string]any) bool { return e["id"] == "x" })

	if e["event"] != "error" || e["code"] != "unknown-op" || e["message"] != "Unknown voice request sing." {
		t.Errorf("an unknown op = %v", e)
	}
}

func TestVoiceWithoutALock(t *testing.T) {
	h := newHarness(t, voiceSettings{Root: t.TempDir()}, helperFiles(t, nil), testPlatform{})

	h.send(`{"type":"voice","op":"install"}`)
	e := h.waitFor("an error", isStatus("error"))

	if e["message"] != "The voice lock file is missing." || e["code"] != codeLockFailed {
		t.Errorf("status = %v", e)
	}
}

func TestVoiceInstallChecksTheFreeSpaceFirst(t *testing.T) {
	archive, model := []byte("archive"), []byte("model!")
	root := filepath.Join(t.TempDir(), "Voice")
	h := newHarness(t, voiceSettings{Root: root}, helperFiles(t, testLock(archive, model)),
		testPlatform{free: 900_000_000, hasFree: true})

	h.send(`{"type":"voice","op":"install"}`)
	e := h.waitFor("an error", isStatus("error"))

	want := "Spoken lines need 1.1 GB of free disk space (a 0.0 GB download, then room to unpack it); " +
		"this PC has 0.9 GB free. Free some space, then try again."
	if e["message"] != want {
		t.Errorf("message = %q, want %q", e["message"], want)
	}

	// The page words it from its code and the two sizes.
	need := float64(len(archive) + len(model) + diskMargin)
	if e["code"] != codeDiskSpace || e["needBytes"] != need || e["freeBytes"] != float64(900_000_000) {
		t.Errorf("status = %v, want disk-space with needBytes %v and freeBytes 9e8", e, need)
	}

	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Error("a refused install made the voice folder")
	}
}

func TestVoiceInstallSpeakAndRemove(t *testing.T) {
	python := venvPython(t)
	archive, model := fakePython(t, python), []byte("the model's bytes")
	lock := testLock(archive, model)
	server := newVoiceServer(t, archive, model)
	root := filepath.Join(t.TempDir(), "Kinetic", "Voice")
	files := helperFiles(t, lock)
	h := newHarness(t, voiceSettings{Root: root, DownloadBase: server.URL}, files, testPlatform{})
	total := float64(len(archive) + len(model))

	h.send(`{"type":"voice","op":"install"}`)
	h.waitFor("ready", isStatus("ready"))

	// One scale across the Python download and the helper's install,
	// never going back, ending full.
	var last float64

	for _, e := range h.seen {
		if e["state"] != "installing" {
			continue
		}

		done, _ := e["done"].(float64)
		if e["total"] != total || done < last || e["downloadBytes"] != total {
			t.Errorf("progress %v after %v (total %v)", e, last, total)
		}

		last = done
	}

	if last != total {
		t.Errorf("progress ended at %v of %v", last, total)
	}

	if server.count(archivePath) != 1 || server.count(modelPath) != 1 {
		t.Errorf("requests: %v", server.requests)
	}

	// The voice folder: Python, the helper as embedded, its lock under the
	// download base, the helper's own install.
	marker, _ := os.ReadFile(filepath.Join(root, "python", pythonMarker))
	if string(marker) != sha256Text(archive) {
		t.Errorf("marker = %q", marker)
	}

	_ = fs.WalkDir(files, "kinetic_voice", func(path string, d fs.DirEntry, _ error) error {
		if d.IsDir() {
			return nil
		}

		got, err := os.ReadFile(filepath.Join(root, "helper", filepath.FromSlash(path)))
		if err != nil || !bytes.Equal(got, files[path].Data) {
			t.Errorf("helper/%s differs from the embedded file: %v", path, err)
		}

		return nil
	})

	written, _ := os.ReadFile(filepath.Join(root, "helper", voiceLockName))
	if !bytes.Contains(written, []byte(server.URL+"/huggingface.co")) ||
		!bytes.Contains(written, []byte(server.URL+archivePath)) {
		t.Errorf("the helper's lock is not under the download base:\n%s", written)
	}

	for _, want := range []string{"state.json", "models/models--test--voice/snapshots/rev1/model.bin", "helper.log"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(want))); err != nil {
			t.Errorf("%s: %v", want, err)
		}
	}

	if _, err := os.Stat(filepath.Join(root, "downloads")); !os.IsNotExist(err) {
		t.Error("downloads/ is still there")
	}

	// A voice, a line, a streamed line.
	h.send(`{"type":"voice","op":"voice","id":1,"data":"` + wavClip() + `","format":"wav","text":"A clip."}`)
	e := h.waitFor("voice", isEvent("voice", 1))
	clip, _ := base64.StdEncoding.DecodeString(wavClip())
	voiceID := sha256Text(clip)

	if e["voiceId"] != voiceID {
		t.Errorf("voice = %v, want voiceId %s", e, voiceID)
	}

	h.send(`{"type":"voice","op":"speak","id":2,"voiceId":"` + voiceID + `","text":"Hello there.","priority":1}`)
	e = h.waitFor("speech", isEvent("speech", 2))

	wav, _ := base64.StdEncoding.DecodeString(fmt.Sprint(e["wav"]))
	if !bytes.HasPrefix(wav, []byte("RIFF")) || e["seconds"].(float64) <= 0 || e["cached"] != false || e["ok"] != nil {
		t.Errorf("speech = %v", e)
	}

	h.send(`{"type":"voice","op":"speak","id":"s3","voiceId":"` + voiceID + `","text":"` +
		strings.Repeat("A streamed line. ", 6) + `","stream":true}`)
	e = h.waitFor("streamed speech", func(e map[string]any) bool { return e["event"] == "speech" && e["id"] == "s3" })

	chunks := 0

	for _, c := range h.seen {
		if c["event"] == "chunk" {
			if c["id"] != "s3" || c["target"] != nil || c["wav"] == nil {
				t.Errorf("chunk = %v", c)
			}

			chunks++
		}
	}

	if chunks < 2 {
		t.Errorf("%d chunks before the streamed line's answer", chunks)
	}

	// The same line again comes from the cache.
	h.send(`{"type":"voice","op":"speak","id":4,"voiceId":"` + voiceID + `","text":"Hello there.","priority":1}`)
	if e = h.waitFor("cached speech", isEvent("speech", 4)); e["cached"] != true {
		t.Errorf("a reread = %v", e)
	}

	// The line's language reaches the helper (docs/plan.md Phase 56 item
	// 6): the same text in German is made again, then cached as German,
	// and a language the engine lacks is refused.
	h.send(`{"type":"voice","op":"speak","id":5,"voiceId":"` + voiceID + `","text":"Hello there.","priority":1,"lang":"de"}`)
	if e = h.waitFor("German speech", isEvent("speech", 5)); e["cached"] != false {
		t.Errorf("the line in German = %v, want it made, not the English line's cache", e)
	}

	h.send(`{"type":"voice","op":"speak","id":6,"voiceId":"` + voiceID + `","text":"Hello there.","priority":1,"lang":"de"}`)
	if e = h.waitFor("cached German speech", isEvent("speech", 6)); e["cached"] != true {
		t.Errorf("the German line again = %v", e)
	}

	h.send(`{"type":"voice","op":"speak","id":7,"voiceId":"` + voiceID + `","text":"Hello there.","priority":1,"lang":"vi"}`)
	if e = h.waitFor("refused speech", isEvent("error", 7)); e["code"] != "bad-request" {
		t.Errorf("a language the engine lacks = %v", e)
	}

	h.send(`{"type":"voice","op":"status"}`)
	h.waitFor("ready", isStatus("ready"))

	h.send(`{"type":"voice","op":"remove"}`)
	if e = h.waitFor("absent", isStatus("absent")); e["downloadBytes"] != total {
		t.Errorf("after remove: %v", e)
	}

	if _, err := os.Stat(root); !os.IsNotExist(err) {
		entries, _ := os.ReadDir(root)
		t.Errorf("the voice folder is still there after remove: %v", entries)
	}

	// The parent folder stays.
	if _, err := os.Stat(filepath.Dir(root)); err != nil {
		t.Errorf("remove took the voice folder's parent: %v", err)
	}
}

func TestVoiceInstallCancelThenResume(t *testing.T) {
	python := venvPython(t)
	archive, model := fakePython(t, python), []byte("m")
	server := newVoiceServer(t, archive, model)
	server.slow.Store(true)

	root := t.TempDir()
	h := newHarness(t, voiceSettings{Root: root, DownloadBase: server.URL}, helperFiles(t, testLock(archive, model)),
		testPlatform{free: 100 << 30, hasFree: true})

	h.send(`{"type":"voice","op":"install"}`)
	h.waitFor("progress", func(e map[string]any) bool {
		done, _ := e["done"].(float64)

		return e["state"] == "installing" && done > 0
	})
	h.send(`{"type":"voice","op":"cancel"}`)
	h.waitFor("absent", isStatus("absent"))

	partials, _ := filepath.Glob(filepath.Join(root, "downloads", "python-*.tar.gz.partial"))
	if len(partials) != 1 {
		t.Fatalf("partial downloads: %v", partials)
	}

	info, _ := os.Stat(partials[0])
	if info.Size() == 0 || info.Size() >= int64(len(archive)) {
		t.Fatalf("partial size %d of %d", info.Size(), len(archive))
	}

	// The next install continues it.
	h.send(`{"type":"voice","op":"install"}`)
	e := h.waitFor("installing", isStatus("installing"))

	if e["done"].(float64) < float64(info.Size()) {
		t.Errorf("a resumed install starts at %v, not at the %d bytes it has", e["done"], info.Size())
	}

	h.waitFor("ready", isStatus("ready"))

	server.mu.Lock()
	ranges := server.ranges[archivePath]
	server.mu.Unlock()

	if len(ranges) != 2 || ranges[0] != "" || !strings.HasPrefix(ranges[1], "bytes=") {
		t.Errorf("archive requests' ranges: %q", ranges)
	}
}

func TestVoiceInstallWithABadChecksum(t *testing.T) {
	archive, model := []byte("not the archive the lock names"), []byte("m")
	lock := testLock([]byte("the real one"), model)
	lock = bytes.Replace(lock, []byte(fmt.Sprintf(`"size": %d`, len("the real one"))),
		[]byte(fmt.Sprintf(`"size": %d`, len(archive))), 1)
	server := newVoiceServer(t, archive, model)
	root := t.TempDir()
	h := newHarness(t, voiceSettings{Root: root, DownloadBase: server.URL}, helperFiles(t, lock), testPlatform{})

	h.send(`{"type":"voice","op":"install"}`)
	e := h.waitFor("error", isStatus("error"))

	if e["message"] != "The Python download did not match its checksum, so it was deleted. Try again." ||
		e["code"] != codeHashMismatch {
		t.Errorf("status = %v", e)
	}

	if partials, _ := filepath.Glob(filepath.Join(root, "downloads", "*")); len(partials) != 0 {
		t.Errorf("the bad download is kept: %v", partials)
	}
}

// minimalLock is a lock with nothing to fetch beyond Python, for helper
// commands.
const minimalLock = `{"id": "slow-1", "python": {"url": "https://x/p", "sha256": "0", "size": 1}, "wheels": [],` +
	` "model": [], "engine": {"id": "fake"}}`

// slowHelper is a helper command: the repo's helper under the .venv
// Python with the fake engine taking delay seconds a line.
func slowHelper(t *testing.T, root string, delay float64) (string, []byte) {
	python := venvPython(t)
	lock := []byte(minimalLock)
	lockFile := filepath.Join(t.TempDir(), "lock.json")
	writeFile(t, lockFile, lock)

	return fmt.Sprintf(`"%s" -I -B "%s" --engine fake --fake-delay %g --lock "%s" --root "%s"`, python,
		filepath.Join(repoRoot, "apps", "voice", "kinetic_voice", "__main__.py"), delay, lockFile, root), lock
}

func TestVoiceDropAndTheHelpersRestart(t *testing.T) {
	root := t.TempDir()
	command, lock := slowHelper(t, root, 0.6)
	h := newHarness(t, voiceSettings{Root: root, HelperCommand: command}, helperFiles(t, lock), testPlatform{})

	// A helper command starts for a status: its downloadBytes, no Python.
	h.send(`{"type":"voice","op":"status"}`)
	if e := h.waitFor("absent", isStatus("absent")); e["downloadBytes"] != float64(0) {
		t.Errorf("status = %v", e)
	}

	h.send(`{"type":"voice","op":"voice","id":1,"data":"` + wavClip() + `","format":"wav"}`)
	voiceID := h.waitFor("voice", isEvent("voice", 1))["voiceId"].(string)

	speak := func(id int, text string) {
		h.send(fmt.Sprintf(`{"type":"voice","op":"speak","id":%d,"voiceId":"%s","text":"%s","priority":1}`, id,
			voiceID, text))
	}

	// 10 runs; 11 and 12 queue behind it. Dropping 12 cancels it, dropping
	// 10 lets it finish unseen: the page gets dropped for each, once.
	speak(10, "Line ten.")
	speak(11, "Line eleven.")
	speak(12, "Line twelve.")
	time.Sleep(200 * time.Millisecond)
	h.send(`{"type":"voice","op":"drop","id":12}`)
	h.send(`{"type":"voice","op":"drop","id":10}`)
	h.send(`{"type":"voice","op":"drop","id":99}`)
	h.waitFor("speech for 11", isEvent("speech", 11))

	for _, e := range append(h.seen, h.quiet(time.Second)...) {
		id, _ := e["id"].(float64)
		if id == 10 || id == 12 {
			if e["event"] != "dropped" {
				t.Errorf("a dropped line gave %v", e)
			}
		}

		if id == 99 {
			t.Errorf("a drop for no line gave %v", e)
		}
	}

	if n := countEvents(h.seen, "dropped", 10) + countEvents(h.seen, "dropped", 12); n != 2 {
		t.Errorf("%d dropped events for 10 and 12, want one each: %v", n, h.seen)
	}

	// A crash: the helper starts again, gets the voice again, and the
	// line in progress is sent again.
	speak(20, "Line twenty.")
	time.Sleep(200 * time.Millisecond)
	h.killHelper()

	if e := h.waitFor("speech for 20", isEvent("speech", 20)); e["wav"] == nil {
		t.Errorf("speech = %v", e)
	}

	// A second crash: an error, and the line's own error.
	speak(21, "Line twenty-one.")
	time.Sleep(200 * time.Millisecond)
	h.killHelper()

	e := h.waitFor("error", isStatus("error"))
	if !strings.HasPrefix(e["message"].(string), "The voice helper stopped unexpectedly. Its log is ") ||
		e["code"] != codeHelperCrashed {
		t.Errorf("status = %v", e)
	}

	if e := h.expect("an error for 21", isEvent("error", 21)); e["code"] != "helper-crashed" {
		t.Errorf("the line's answer = %v", e)
	}

	// A status starts afresh.
	h.send(`{"type":"voice","op":"status"}`)
	h.waitFor("absent", isStatus("absent"))
	speak(22, "Line twenty-two.")
	h.waitFor("speech for 22", isEvent("speech", 22))

	if log, _ := os.ReadFile(filepath.Join(root, "helper.log")); !bytes.Contains(log, []byte("crash 2")) {
		t.Errorf("helper.log:\n%s", log)
	}
}

func countEvents(events []map[string]any, event string, id float64) int {
	n := 0

	for _, e := range events {
		if e["event"] == event && e["id"] == id {
			n++
		}
	}

	return n
}

func (h *harness) killHelper() {
	h.t.Helper()

	var cmd *exec.Cmd

	h.e.do(func() {
		if h.e.helper != nil {
			cmd = h.e.helper.cmd
		}
	})

	if cmd == nil {
		h.t.Fatal("no helper running")
	}

	if err := cmd.Process.Kill(); err != nil {
		h.t.Fatal(err)
	}
}

// scriptedHelper is a helper command that answers each op as told
// (answers: op -> the answer's fields), as JSON lines.
func scriptedHelper(t *testing.T, answers map[string]map[string]any) string {
	python := venvPython(t)
	data, _ := json.Marshal(answers)
	script := filepath.Join(t.TempDir(), "helper.py")
	writeFile(t, script, []byte(`import json, sys
answers = json.loads(`+"'"+string(data)+"'"+`)
print(json.dumps({"event": "log", "message": "scripted"}), flush=True)
print(json.dumps({"id": 999, "ok": True}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "install":
        print(json.dumps({"event": "progress", "done": 100, "total": 100}), flush=True)
    answer = dict(answers.get(op, {"ok": True}))
    answer["id"] = req["id"]
    print(json.dumps(answer), flush=True)
`))

	return fmt.Sprintf(`"%s" -I "%s"`, python, script)
}

func TestVoiceInstallFailuresReachTheReaderInWords(t *testing.T) {
	for code, want := range map[string]string{
		"download-failed":    "A download failed (it broke). Try again to continue it.",
		"hash-mismatch":      "A download did not match its checksum (it broke). Try again.",
		"pip-failed":         "Installing the voice packages failed (it broke).",
		"install-failed":     "The voice install failed (it broke).",
		"unsupported-system": "Spoken lines do not run on this system (it broke).",
	} {
		t.Run(code, func(t *testing.T) {
			command := scriptedHelper(t, map[string]map[string]any{
				"install": {"ok": false, "code": code, "error": "it broke"},
			})
			h := newHarness(t, voiceSettings{Root: t.TempDir(), HelperCommand: command},
				helperFiles(t, []byte(minimalLock)), testPlatform{})

			h.send(`{"type":"voice","op":"install"}`)

			state := "error"
			if code == "unsupported-system" {
				state = "unsupported"
			}

			// The helper's code is the page's code for it.
			if e := h.waitFor(state, isStatus(state)); e["message"] != want || e["code"] != code {
				t.Errorf("status = %v, want %q and code %s", e, want, code)
			}

			// The helper's progress was on the install's scale.
			found := false

			for _, e := range h.seen {
				if e["state"] == "installing" && e["done"] == float64(100) && e["total"] == float64(100) {
					found = true
				}
			}

			if !found {
				t.Errorf("no progress at 100 of 100: %v", h.seen)
			}
		})
	}
}

func TestVoiceStatusFromTheHelper(t *testing.T) {
	command := scriptedHelper(t, map[string]map[string]any{
		"status": {"ok": true, "installed": true, "downloadBytes": 1234},
		"speak":  {"ok": false, "code": "cancelled", "error": "cancelled"},
		"voice":  {"ok": false, "code": "bad-request", "error": "bad clip"},
	})
	root := t.TempDir()
	h := newHarness(t, voiceSettings{Root: root, HelperCommand: command}, helperFiles(t, []byte(minimalLock)),
		testPlatform{})

	h.send(`{"type":"voice","op":"status"}`)
	if e := h.waitFor("ready", isStatus("ready")); e["downloadBytes"] != float64(1234) {
		t.Errorf("status = %v", e)
	}

	// A cancelled line is dropped for the page; a refusal is its error.
	h.send(`{"type":"voice","op":"speak","id":1,"voiceId":"v","text":"x"}`)
	h.waitFor("dropped", isEvent("dropped", 1))
	h.send(`{"type":"voice","op":"voice","id":2,"data":"","format":"wav"}`)

	if e := h.waitFor("error", isEvent("error", 2)); e["code"] != "bad-request" || e["message"] != "bad clip" {
		t.Errorf("voice = %v", e)
	}

	log, _ := os.ReadFile(filepath.Join(root, "helper.log"))
	for _, want := range []string{"helper started", `helper: {"event":"log","message":"scripted"}`,
		"helper answered no request"} {
		if !bytes.Contains(log, []byte(want)) {
			t.Errorf("helper.log lacks %q:\n%s", want, log)
		}
	}
}

func TestVoiceShutdownStopsTheHelper(t *testing.T) {
	root := t.TempDir()
	command, lock := slowHelper(t, root, 0)
	h := newHarness(t, voiceSettings{Root: root, HelperCommand: command}, helperFiles(t, lock), testPlatform{})

	h.send(`{"type":"voice","op":"status"}`)
	h.waitFor("absent", isStatus("absent"))

	var cmd *exec.Cmd

	h.e.do(func() { cmd = h.e.helper.cmd })
	h.e.shutdown()

	done := make(chan struct{})

	go func() {
		// Signal 0 fails once the process has ended and been waited for.
		for cmd.Process.Signal(syscall.Signal(0)) == nil {
			time.Sleep(10 * time.Millisecond)
		}

		close(done)
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("the helper still runs after shutdown")
	}
}

func TestSerialQueueRunsInOrder(t *testing.T) {
	q := newSerialQueue()

	var got []int

	for i := range 1000 {
		q.post(func() { got = append(got, i) })
	}

	q.sync(func() {})

	for i, v := range got {
		if v != i {
			t.Fatalf("job %d ran as %d", i, v)
		}
	}

	if len(got) != 1000 {
		t.Fatalf("%d jobs ran", len(got))
	}
}

func TestVoiceUnsupportedWithoutAnNvidiaCard(t *testing.T) {
	archive, model := []byte("archive"), []byte("model!")
	root := filepath.Join(t.TempDir(), "Voice")
	server := newVoiceServer(t, archive, model)
	calls := &atomic.Int32{}
	h := newHarness(t, voiceSettings{Root: root, DownloadBase: server.URL}, helperFiles(t, testLock(archive, model)),
		testPlatform{smiErr: errors.New("nvidia-smi is not here"), smiCalls: calls})

	h.send(`{"type":"voice","op":"status"}`)
	e := h.waitFor("unsupported", isStatus("unsupported"))

	if e["message"] != noGPUMessage || e["code"] != codeNoNvidia || e["version"] != nil {
		t.Errorf("status = %v, want %q and code no-nvidia", e, noGPUMessage)
	}

	if e["downloadBytes"] != float64(len(archive)+len(model)) {
		t.Errorf("downloadBytes = %v, want the whole download, for the greyed button", e["downloadBytes"])
	}

	// An install is refused, and nothing is written or fetched.
	h.send(`{"type":"voice","op":"install"}`)
	e = h.waitFor("unsupported again", isStatus("unsupported"))

	if e["message"] != noGPUMessage {
		t.Errorf("install message = %v", e["message"])
	}

	h.send(`{"type":"voice","op":"status"}`)
	h.waitFor("unsupported a third time", isStatus("unsupported"))

	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Error("a refused install made the voice folder")
	}

	if n := server.count(archivePath) + server.count(modelPath); n != 0 {
		t.Errorf("a refused install made %d downloads", n)
	}

	if n := calls.Load(); n != 1 {
		t.Errorf("nvidia-smi ran %d times, want once", n)
	}
}

func TestVoiceUnsupportedWithAnOldDriver(t *testing.T) {
	archive, model := []byte("archive"), []byte("model!")
	lock := strings.Replace(string(testLock(archive, model)), `"engine"`, `"cudaMinDriver": "570.65", "engine"`, 1)
	h := newHarness(t, voiceSettings{Root: filepath.Join(t.TempDir(), "Voice")}, helperFiles(t, []byte(lock)),
		testPlatform{smi: "NVIDIA GeForce GTX 1060, 566.36\r\n"})

	h.send(`{"type":"voice","op":"install"}`)
	e := h.waitFor("unsupported", isStatus("unsupported"))

	if e["message"] != oldDriverMessage || e["code"] != codeNvidiaDriver || e["version"] != "570.65" {
		t.Errorf("status = %v, want %q, code nvidia-driver and version 570.65", e, oldDriverMessage)
	}
}

func TestVoiceStatusWithAnNvidiaCardIsAsBefore(t *testing.T) {
	archive, model := []byte("archive"), []byte("model!")
	lock := strings.Replace(string(testLock(archive, model)), `"engine"`, `"cudaMinDriver": "570.65", "engine"`, 1)
	h := newHarness(t, voiceSettings{Root: filepath.Join(t.TempDir(), "Voice")}, helperFiles(t, []byte(lock)), testPlatform{})

	h.send(`{"type":"voice","op":"status"}`)
	e := h.waitFor("absent", isStatus("absent"))

	if e["message"] != nil {
		t.Errorf("a supported PC's status has a message: %v", e)
	}
}
