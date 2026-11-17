package main

// Spoken lines (docs/plan.md Phase 52; apps/README.md, "Spoken lines"):
// what the exe's voice host is made of, apart from the engine
// (voice_engine.go), the downloads (voice_fetch.go) and the Windows calls
// (voice_windows.go). Platform-neutral (voice_test.go).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	// voiceLockName is the lock's name in the embedded files and in the
	// voice folder's helper/, where the helper is told to read it.
	// The host build (kinetic_extract/app_hosts.py) copies
	// apps/voice/lock-windows-x64.json in as it.
	voiceLockName = "lock-windows-x64.json"
	// voiceReceiver is the page's function for voice events.
	voiceReceiver = "__kineticVoice"
	// hostVoice is where the host script keeps its voice deliverer (not
	// enumerable): it calls voiceReceiver, and holds the latest status
	// while the page has none.
	hostVoice = "__kineticHostVoice"
)

// embeddedVoice is the helper the exe carries: kinetic_voice/*.py and the
// lock (voiceLockName). The host build (kinetic_extract/app_hosts.py)
// generates voice_embedded.go, which sets it, into the package copy it
// builds from; without it (go
// test, or a build without the Windows lock) the exe offers no voice.
var embeddedVoice fs.FS

// voiceSettings is where the voice folder is and what the tests replace
// (apps/README.md, "Test overrides"; never set for readers).
type voiceSettings struct {
	// Root is the voice folder, %LOCALAPPDATA%\Kinetic\Voice, shared by
	// every Kinetic game on the PC ("" when there is no such folder).
	Root string
	// DownloadBase, when set, puts every download URL https://host/path
	// at <base>/host/path, in the lock written for the helper too.
	DownloadBase string
	// LockFile is a lock file in place of the embedded one.
	LockFile string
	// NvidiaSmi is the program that asks for the graphics card, in place
	// of the PC's own nvidia-smi; "off" is no such program.
	NvidiaSmi string
	// Python runs the embedded helper; no Python download.
	Python string
	// HelperCommand is a whole command line run in place of the helper;
	// no Python download, and the helper starts for any request.
	HelperCommand string
}

// voiceSettingsFrom reads the settings from the environment; relative
// paths are taken from cwd, the exe's working directory.
func voiceSettingsFrom(getenv func(string) string, cwd string) voiceSettings {
	absolute := func(path string) string {
		if path == "" || filepath.IsAbs(path) {
			return path
		}

		return filepath.Join(cwd, path)
	}

	s := voiceSettings{
		Root:          absolute(getenv("KINETIC_VOICE_DIR")),
		DownloadBase:  getenv("KINETIC_VOICE_DOWNLOAD_BASE"),
		LockFile:      absolute(getenv("KINETIC_VOICE_LOCK")),
		NvidiaSmi:     absoluteUnlessOff(getenv("KINETIC_VOICE_NVIDIA_SMI"), absolute),
		Python:        absolute(getenv("KINETIC_VOICE_PYTHON")),
		HelperCommand: getenv("KINETIC_VOICE_HELPER"),
	}

	if s.Root == "" {
		if local := getenv("LOCALAPPDATA"); local != "" {
			s.Root = winJoin(local, "Kinetic", "Voice")
		}
	}

	return s
}

func absoluteUnlessOff(path string, absolute func(string) string) string {
	if path == "off" {
		return path
	}

	return absolute(path)
}

// The codes the page gets with an error or an unsupported machine
// (docs/plan.md Phase 56 item 7; apps/README.md, "The voice bridge"),
// which it words from the player's catalogue; the message beside each is
// an English detail for the log.
const (
	codeUnsupportedSystem = "unsupported-system"
	codeNoNvidia          = "no-nvidia"
	codeNvidiaDriver      = "nvidia-driver"
	codeDiskSpace         = "disk-space"
	codeDownloadFailed    = "download-failed"
	codeHashMismatch      = "hash-mismatch"
	codePipFailed         = "pip-failed"
	codeInstallFailed     = "install-failed"
	codeFolderFailed      = "folder-failed"
	codeHelperFailed      = "helper-failed"
	codeHelperCrashed     = "helper-crashed"
	codeLockFailed        = "lock-failed"
)

// voiceProblem is an error or an unsupported machine as the page gets it:
// Code names it, Message is the English detail, and Fields are the code's
// own numbers (version; needBytes and freeBytes).
type voiceProblem struct {
	Code    string
	Message string
	Fields  map[string]any
}

func (p *voiceProblem) Error() string { return p.Message }

// problemf is a voice problem with code and an English detail.
func problemf(code, format string, args ...any) *voiceProblem {
	return &voiceProblem{Code: code, Message: fmt.Sprintf(format, args...)}
}

// problemOf is err as a voice problem: its own, else install-failed with
// err's words as the detail.
func problemOf(err error) *voiceProblem {
	var p *voiceProblem
	if errors.As(err, &p) {
		return p
	}

	return &voiceProblem{Code: codeInstallFailed, Message: err.Error()}
}

// errLockUnreadable is a lock the exe cannot use.
var errLockUnreadable = &voiceProblem{Code: codeLockFailed, Message: "The voice lock file is not readable."}

// voiceLock is what the exe needs of the lock (apps/voice/README.md, "The
// lock"): the Python build it downloads itself and the sizes of what the
// helper downloads.
type voiceLock struct {
	ID           string
	PythonURL    string
	PythonSHA256 string
	PythonSize   int64
	// CudaMinDriver is the oldest NVIDIA driver the PyTorch build in the
	// lock runs on ("" for none).
	CudaMinDriver string
	// HelperBytes is what the helper's install fetches: every wheel and
	// every model file. The helper's own progress replaces it once its
	// install runs.
	HelperBytes int64
	// HelperText is the lock as the helper gets it (URLs moved under the
	// download base when one is set).
	HelperText []byte
}

// parseVoiceLock reads a lock; base is the test download base, or "".
func parseVoiceLock(data []byte, base string) (*voiceLock, error) {
	var raw struct {
		ID     *string `json:"id"`
		Python *struct {
			URL    string `json:"url"`
			SHA256 string `json:"sha256"`
			Size   *int64 `json:"size"`
		} `json:"python"`
		CudaMinDriver string `json:"cudaMinDriver"`
		Wheels        *[]struct {
			Size int64 `json:"size"`
		} `json:"wheels"`
		Model *[]struct {
			Size int64 `json:"size"`
		} `json:"model"`
	}

	if json.Unmarshal(data, &raw) != nil || raw.ID == nil || raw.Python == nil || raw.Python.URL == "" ||
		raw.Python.SHA256 == "" || raw.Python.Size == nil || raw.Wheels == nil || raw.Model == nil {
		return nil, errLockUnreadable
	}

	var helper int64
	for _, w := range *raw.Wheels {
		helper += w.Size
	}

	for _, m := range *raw.Model {
		helper += m.Size
	}

	lock := &voiceLock{
		ID: *raw.ID, PythonURL: redirectURL(raw.Python.URL, base), PythonSHA256: raw.Python.SHA256,
		PythonSize: *raw.Python.Size, CudaMinDriver: raw.CudaMinDriver, HelperBytes: helper, HelperText: data,
	}

	if base != "" {
		text, err := redirectLock(data, base)
		if err != nil {
			return nil, errLockUnreadable
		}

		lock.HelperText = text
	}

	return lock, nil
}

// redirectLock is the lock with its Python, wheel and model URLs under
// base, every other field as it was.
func redirectLock(data []byte, base string) ([]byte, error) {
	var lock map[string]any

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	if err := dec.Decode(&lock); err != nil {
		return nil, err
	}

	move := func(entry any) {
		if m, ok := entry.(map[string]any); ok {
			if url, ok := m["url"].(string); ok {
				m["url"] = redirectURL(url, base)
			}
		}
	}

	move(lock["python"])

	wheels, _ := lock["wheels"].([]any)
	for _, w := range wheels {
		move(w)
	}

	model, _ := lock["modelBaseUrl"].(string)
	if model == "" {
		model = "https://huggingface.co"
	}

	lock["modelBaseUrl"] = redirectURL(model, base)

	return marshalJSON(lock, "  ")
}

// redirectURL is url with its scheme and host moved under base
// (https://host/path to <base>/host/path), when a base is set.
func redirectURL(url, base string) string {
	_, rest, ok := strings.Cut(url, "://")
	if base == "" || !ok {
		return url
	}

	return strings.TrimSuffix(base, "/") + "/" + rest
}

// marshalJSON is value as JSON without HTML escaping (the helper and the
// page read it, never a browser's HTML parser), indented when indent is
// set.
func marshalJSON(value any, indent string) ([]byte, error) {
	var buf bytes.Buffer

	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)

	if indent != "" {
		enc.SetIndent("", indent)
	}

	if err := enc.Encode(value); err != nil {
		return nil, err
	}

	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// decodeJSON reads one JSON object, keeping numbers as their text so ids
// and sizes come back exactly as sent.
func decodeJSON(data []byte) (map[string]any, bool) {
	var m map[string]any

	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()

	if dec.Decode(&m) != nil || m == nil {
		return nil, false
	}

	return m, true
}

// parseVoiceMessage reads a page message that is a voice request:
// {type: "voice", op, ...}.
func parseVoiceMessage(text string) (map[string]any, bool) {
	m, ok := decodeJSON([]byte(text))
	if !ok || m["type"] != "voice" {
		return nil, false
	}

	if _, ok := m["op"].(string); !ok {
		return nil, false
	}

	return m, true
}

// voiceScript gives the page one voice event, through the host script's
// deliverer (hostScript), which calls the page's receiver if it has one.
func voiceScript(event map[string]any) string {
	data, err := marshalJSON(event, "")
	if err != nil {
		data = []byte(`{"event":"error","code":"bad-event","message":"The voice event is not JSON."}`)
	}

	return "window." + hostVoice + " && window." + hostVoice + "(" + string(data) + ");"
}

// sameID reports whether two request ids, as decoded, are the same JSON
// value.
func sameID(a, b any) bool {
	x, errX := json.Marshal(a)
	y, errY := json.Marshal(b)

	return errX == nil && errY == nil && bytes.Equal(x, y)
}

// gigabytes formats a byte count for the reader.
func gigabytes(n int64) string {
	return fmt.Sprintf("%.1f GB", float64(n)/1e9)
}

// Spoken lines run on an NVIDIA card only (docs/plan.md Phase 52 item 12):
// the PyTorch build is CUDA, and on a CPU lines took 1.6 times as long as
// they last.

// gpuCheck is what the PC's graphics card allows. Reason is "" when spoken
// lines can run, else why not, in English; Code names it for the page's
// words for the ? beside the greyed download button, and Version is the
// driver needed with codeNvidiaDriver.
type gpuCheck struct {
	GPU, Driver, Reason string
	Code, Version       string
}

// problem is the check's reason as the page gets it (nil when lines can
// run).
func (c gpuCheck) problem() *voiceProblem {
	if c.Reason == "" {
		return nil
	}

	p := &voiceProblem{Code: c.Code, Message: c.Reason}
	if c.Version != "" {
		p.Fields = map[string]any{"version": c.Version}
	}

	return p
}

const (
	noNvidiaReason = "Spoken lines need an NVIDIA graphics card. This computer doesn't have one."
	// nvidiaQuery is what the exe asks nvidia-smi: one line per card,
	// "<name>, <driver version>".
	nvidiaQuery = "--query-gpu=name,driver_version"
)

// checkNvidia reads nvidia-smi's answer (its output, and the error from
// running it: missing, failed or hung) against the lock's minimum driver.
// A driver it cannot read as a version number is not held against the
// card.
func checkNvidia(output string, runErr error, minDriver string) gpuCheck {
	if runErr != nil {
		return gpuCheck{Reason: noNvidiaReason, Code: codeNoNvidia}
	}

	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)

		cut := strings.LastIndex(line, ",")
		if cut <= 0 {
			continue
		}

		check := gpuCheck{GPU: strings.TrimSpace(line[:cut])}
		if driver := strings.TrimSpace(line[cut+1:]); versionNumbers(driver) != nil {
			check.Driver = driver
		}

		if check.Driver != "" && minDriver != "" && compareVersions(check.Driver, minDriver) < 0 {
			check.Reason = fmt.Sprintf("Spoken lines need NVIDIA driver %s or later. "+
				"Update the graphics driver to use them.", minDriver)
			check.Code, check.Version = codeNvidiaDriver, minDriver
		}

		return check
	}

	return gpuCheck{Reason: noNvidiaReason, Code: codeNoNvidia}
}

// versionNumbers is "572.83" as [572 83]; nil when it is not dotted numbers.
func versionNumbers(text string) []int {
	var numbers []int

	for _, part := range strings.Split(text, ".") {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return nil
		}

		numbers = append(numbers, n)
	}

	return numbers
}

// compareVersions compares dotted numbers by value, not by text: -1, 0 or 1.
func compareVersions(a, b string) int {
	x, y := versionNumbers(a), versionNumbers(b)

	for i := range max(len(x), len(y)) {
		var p, q int
		if i < len(x) {
			p = x[i]
		}

		if i < len(y) {
			q = y[i]
		}

		if p != q {
			if p < q {
				return -1
			}

			return 1
		}
	}

	return 0
}

// runNvidiaSmi runs the program at exe for the cards' names and driver
// version and returns its output; an error when it is missing, fails or
// takes longer than limit. prepare hides its window (voicePlatform).
func runNvidiaSmi(exe string, prepare func(*exec.Cmd), limit time.Duration) (string, error) {
	if exe == "" {
		return "", errors.New("nvidia-smi was not found")
	}

	ctx, cancel := context.WithTimeout(context.Background(), limit)
	defer cancel()

	cmd := exec.CommandContext(ctx, exe, nvidiaQuery, "--format=csv,noheader")
	prepare(cmd)

	out, err := cmd.Output()

	return string(out), err
}
