package main

// The voice host (docs/plan.md Phase 52 item 9; apps/README.md, "Spoken
// lines"): the Windows counterpart of apps/macos/VoiceEngine.swift, which
// it follows step for step. It owns the PC's voice folder
// (%LOCALAPPDATA%\Kinetic\Voice, shared by every Kinetic game): it
// downloads and unpacks the private Python the lock names, writes the
// helper (apps/voice, embedded in the exe) into helper\, runs the helper
// with JSON lines on its stdin and stdout, and relays between the page and
// the helper, which installs the packages and model files and voices
// lines (apps/voice/README.md).
//
// Threads: every field below is used on the engine's own goroutine only
// (its serialQueue): the page's messages, the download's progress and end,
// the helper's lines (a reading goroutine hands each over) and its exit.
// The download, the hashing and the unpacking run on goroutines of their
// own and post their results back. deliver is called on the engine's
// goroutine; the Windows side (voice_windows.go) hands each event to the
// UI thread. Platform-neutral but for voicePlatform
// (voice_engine_test.go runs it on macOS with the repo's helper).

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// voicePlatform is what the engine needs of the operating system
// (voice_windows.go on Windows; the tests stand in for it).
type voicePlatform interface {
	// freeBytes is the free space for the user on the volume holding dir
	// (an existing folder); false when it cannot be told.
	freeBytes(dir string) (int64, bool)
	// prepare sets a helper process up to run hidden.
	prepare(cmd *exec.Cmd)
	// shell runs a whole command line (KINETIC_VOICE_HELPER).
	shell(command string) *exec.Cmd
	// nvidiaSmi is nvidia-smi's answer to nvidiaQuery (the cards' names
	// and the driver version, one line each), or the error: it is missing,
	// failed or hung.
	nvidiaSmi() (string, error)
}

// Voice states the page sees ({event: "status", state}).
const (
	voiceAbsent      = "absent"
	voiceInstalling  = "installing"
	voiceReady       = "ready"
	voiceError       = "error"
	voiceUnsupported = "unsupported"
)

const (
	helperLogLimit = 4 << 20
	diskMargin     = 1 << 30
	// progressEvery is the most often install progress reaches the page.
	progressEvery = 250 * time.Millisecond
)

// voiceInstallFiles is what remove deletes (the helper's own remove takes
// its share first, when it can run): every file of the install. The voice
// folder itself goes too once it is empty.
var voiceInstallFiles = []string{
	"python", "python.partial", "downloads", "helper", "lib", "lib.partial", "models", "cache", "state.json",
	"helper.log",
}

// voiceInstall is one install the page started: the Python download, its
// unpacking, then the helper's own install.
type voiceInstall struct {
	cancelled bool
	// thenRemove: the page asked to remove while this ran.
	thenRemove bool
	// stopDownload cancels the download while it runs.
	stopDownload context.CancelFunc
	// helperRequest is the helper's install request, once sent.
	helperRequest int
}

// voiceHelper is the running helper.
type voiceHelper struct {
	cmd   *exec.Cmd
	input io.WriteCloser
	// stopping: stopped by the exe (remove, quit), so its exit is no crash.
	stopping bool
	// onStopped runs once a stopped helper has exited (its files are free
	// to delete then, on Windows).
	onStopped func()
}

// voicePending is a request sent to the helper and not yet answered.
// request is kept to send again to a restarted helper; reply gets the
// answer (or a failure made up when the helper is gone) and whether the
// page dropped it.
type voicePending struct {
	request map[string]any
	pageID  any
	forPage bool
	dropped bool
	reply   func(reply map[string]any, dropped bool)
}

// voiceEngine is the exe's voice host.
type voiceEngine struct {
	settings voiceSettings
	files    fs.FS
	plat     voicePlatform
	deliver  func(map[string]any)
	queue    *serialQueue
	client   *http.Client

	lockLoaded bool
	lock       *voiceLock
	lockErr    error

	// gpu is the graphics card check, made once (nil before).
	gpu *gpuCheck

	state   string
	message string
	// problem names an error or an unsupported machine for the page (its
	// code and numbers); nil in the other states.
	problem       *voiceProblem
	downloadBytes int64
	done          int64
	total         int64
	lastProgress  time.Time
	install       *voiceInstall
	helper        *voiceHelper
	nextRequest   int
	pending       map[int]*voicePending
	// registrations holds each voice the page registered, by voiceId: its
	// voice request, sent again to a restarted helper.
	registrations map[string]map[string]any
	crashes       int
	log           *os.File
}

// newVoiceEngine makes the voice host. files is the embedded helper
// (embeddedVoice); deliver gets each event for the page, on the engine's
// goroutine.
func newVoiceEngine(s voiceSettings, files fs.FS, plat voicePlatform, deliver func(map[string]any)) *voiceEngine {
	return &voiceEngine{
		settings: s, files: files, plat: plat, deliver: deliver, queue: newSerialQueue(),
		client:        &http.Client{},
		nextRequest:   1,
		pending:       map[int]*voicePending{},
		registrations: map[string]map[string]any{},
	}
}

// receive takes one voice message from the page (any goroutine).
func (e *voiceEngine) receive(message map[string]any) {
	e.queue.post(func() { e.handle(message) })
}

// do runs f on the engine's goroutine and waits for it.
func (e *voiceEngine) do(f func()) {
	e.queue.sync(f)
}

// shutdown stops the helper and any download: the exe is closing. A helper
// whose exe was killed exits at the end of its input.
func (e *voiceEngine) shutdown() {
	e.do(func() {
		if e.install != nil && e.install.stopDownload != nil {
			e.install.stopDownload()
		}

		if e.helper != nil {
			e.stopHelper(nil)
		}

		e.helper = nil
	})
}

func (e *voiceEngine) path(name ...string) string {
	return filepath.Join(append([]string{e.settings.Root}, name...)...)
}

// --- page messages ----------------------------------------------------------

func (e *voiceEngine) handle(message map[string]any) {
	op, _ := message["op"].(string)
	id := message["id"]

	switch op {
	case "status":
		e.status()
	case "install":
		e.startInstall()
	case "cancel":
		e.cancelInstall()
	case "remove":
		e.remove()
	case "voice":
		format := message["format"]
		if format == nil {
			format = "wav"
		}

		fields := map[string]any{"voice": message["data"], "format": format}
		if text, ok := message["text"]; ok {
			fields["text"] = text
		}

		e.relay(id, "voice", fields)
	case "speak":
		fields := map[string]any{}

		for k, v := range message {
			if k != "type" && k != "op" && k != "id" {
				fields[k] = v
			}
		}

		e.relay(id, "speak", fields)
	case "drop":
		e.drop(id)
	default:
		e.send(map[string]any{"event": "error", "id": id, "code": "unknown-op",
			"message": "Unknown voice request " + op + "."})
	}
}

func (e *voiceEngine) status() {
	lock := e.currentLock()
	if lock == nil {
		return
	}

	if e.unsupported(lock) {
		return
	}

	if e.install != nil {
		e.push()

		return
	}

	// A status after an error tries again from the start.
	if e.state == voiceError {
		e.crashes = 0
	}

	if e.helper == nil && !e.installComplete(lock) {
		e.downloadBytes = e.fullDownload(lock)
		e.setState(voiceAbsent)

		return
	}

	if !e.startHelper(lock) {
		return
	}

	e.request("status", map[string]any{}, nil, false, func(reply map[string]any, _ bool) {
		e.statusAnswered(reply, lock)
	})
}

// unsupported tells the page when this PC has no NVIDIA card the lock's
// PyTorch can use, with the download's size for the greyed button. The card
// is looked at once, on first use (nvidia-smi takes a moment).
func (e *voiceEngine) unsupported(lock *voiceLock) bool {
	if e.gpu == nil {
		output, err := e.plat.nvidiaSmi()
		check := checkNvidia(output, err, lock.CudaMinDriver)
		e.gpu = &check

		logf("voice: nvidia-smi gave %q (error: %v): graphics card %q, driver %q, %q", output, err,
			check.GPU, check.Driver, check.Reason)
	}

	if e.gpu.Reason == "" {
		return false
	}

	e.downloadBytes = e.fullDownload(lock)
	e.setProblem(voiceUnsupported, e.gpu.problem())

	return true
}

func (e *voiceEngine) statusAnswered(reply map[string]any, lock *voiceLock) {
	if e.install != nil {
		return
	}

	switch {
	case reply["ok"] == true:
		if bytes, ok := asInt64(reply["downloadBytes"]); ok {
			e.downloadBytes = e.pythonBytes(lock) + bytes
		}

		if reply["installed"] == true {
			e.setState(voiceReady)
		} else {
			e.setState(voiceAbsent)
		}
	case reply["code"] == "unsupported-system":
		e.setProblem(voiceUnsupported, problemf(codeUnsupportedSystem, "Spoken lines do not run on this system (%v).",
			reply["error"]))
	default:
		e.setProblem(voiceError, problemf(codeHelperFailed, "The voice helper could not report its state: %v.",
			orDefault(reply["error"], "unknown error")))
	}
}

func (e *voiceEngine) startInstall() {
	lock := e.currentLock()
	if lock == nil {
		return
	}

	if e.unsupported(lock) {
		return
	}

	if e.install != nil {
		e.push()

		return
	}

	e.crashes = 0
	full := e.fullDownload(lock)

	if !e.installComplete(lock) {
		if free, ok := e.plat.freeBytes(nearestFolder(e.settings.Root)); ok && free < full+diskMargin {
			p := problemf(codeDiskSpace, "Spoken lines need %s of free disk space (a %s download, then room "+
				"to unpack it); this PC has %s free. Free some space, then try again.", gigabytes(full+diskMargin),
				gigabytes(full), gigabytes(free))
			p.Fields = map[string]any{"needBytes": full + diskMargin, "freeBytes": free}
			e.setProblem(voiceError, p)

			return
		}
	}

	if err := os.MkdirAll(e.settings.Root, 0o755); err != nil {
		e.setProblem(voiceError, problemf(codeFolderFailed, "The voice folder %s cannot be made: %v", e.settings.Root, err))

		return
	}

	e.openLog()

	if err := e.writeHelper(lock); err != nil {
		e.setProblem(voiceError, problemf(codeFolderFailed, "The voice helper cannot be written: %v", err))

		return
	}

	run := &voiceInstall{}
	e.install = run
	e.downloadBytes = full
	e.total = full

	if e.pythonReady(lock) {
		e.done = e.pythonBytes(lock)
	} else {
		e.done = min(fileSize(e.archivePartial(lock)), lock.PythonSize)
	}

	e.setState(voiceInstalling)

	if e.pythonReady(lock) {
		e.startHelperInstall(run, lock)
	} else {
		e.downloadPython(run, lock)
	}
}

func (e *voiceEngine) cancelInstall() {
	run := e.install
	if run == nil {
		e.status()

		return
	}

	if run.cancelled {
		return
	}

	run.cancelled = true

	switch {
	case run.stopDownload != nil:
		run.stopDownload()
	case run.helperRequest != 0:
		e.request("cancel", map[string]any{"target": run.helperRequest}, nil, false, ignoreReply)
	}
	// While it unpacks, the unpacking finishes and then sees the cancel.
}

func (e *voiceEngine) remove() {
	if run := e.install; run != nil {
		run.thenRemove = true
		e.cancelInstall()

		return
	}

	clear(e.registrations)

	if e.helper == nil {
		e.removeFiles()

		return
	}

	e.request("remove", map[string]any{}, nil, false, func(map[string]any, bool) {
		// On Windows a running program's files cannot be deleted: the
		// files go once the helper has exited.
		e.stopHelper(e.removeFiles)
	})
}

func (e *voiceEngine) removeFiles() {
	e.closeLog()

	for _, name := range voiceInstallFiles {
		if err := os.RemoveAll(e.path(name)); err != nil {
			logf("voice: removing %s: %v", e.path(name), err)
		}
	}

	// Only if empty: an override may point at a folder with more in it.
	_ = os.Remove(e.settings.Root)

	if lock := e.currentLock(); lock != nil {
		e.downloadBytes = e.fullDownload(lock)
	}

	e.setState(voiceAbsent)
}

// relay sends a voice or speak request to the helper.
func (e *voiceEngine) relay(pageID any, op string, fields map[string]any) {
	lock := e.currentLock()
	if lock == nil {
		e.send(map[string]any{"event": "error", "id": pageID, "code": "not-installed", "message": e.message})

		return
	}

	if e.helper == nil && !e.installComplete(lock) {
		e.send(map[string]any{"event": "error", "id": pageID, "code": "not-installed",
			"message": "Spoken lines are not installed."})

		return
	}

	if !e.startHelper(lock) {
		e.send(map[string]any{"event": "error", "id": pageID, "code": "helper-failed", "message": e.message})

		return
	}

	e.request(op, fields, pageID, true, func(reply map[string]any, dropped bool) {
		e.answer(pageID, op, fields, reply, dropped)
	})
}

// answer is the page's event for the helper's answer to its request.
func (e *voiceEngine) answer(pageID any, op string, fields, reply map[string]any, dropped bool) {
	switch {
	case dropped:
		e.send(map[string]any{"event": "dropped", "id": pageID})
	case reply["ok"] == true && op == "voice":
		voiceID, _ := reply["voiceId"].(string)
		e.registrations[voiceID] = fields
		e.send(map[string]any{"event": "voice", "id": pageID, "voiceId": voiceID})
	case reply["ok"] == true:
		event := map[string]any{}

		for k, v := range reply {
			if k != "ok" {
				event[k] = v
			}
		}

		event["event"] = "speech"
		event["id"] = pageID
		e.send(event)
	case reply["code"] == "cancelled":
		e.send(map[string]any{"event": "dropped", "id": pageID})
	default:
		e.send(map[string]any{"event": "error", "id": pageID, "code": orDefault(reply["code"], "error"),
			"message": orDefault(reply["error"], "The voice helper failed.")})
	}
}

// drop: the page no longer wants a line. A queued line is cancelled; one
// already running finishes; either way the page gets dropped for it, once.
func (e *voiceEngine) drop(pageID any) {
	if pageID == nil {
		return
	}

	for _, target := range e.pendingIDs() {
		p := e.pending[target]
		if p.forPage && !p.dropped && sameID(p.pageID, pageID) {
			p.dropped = true
			e.request("cancel", map[string]any{"target": target}, nil, false, ignoreReply)

			return
		}
	}
}

// --- the page's status ------------------------------------------------------

// setState moves to a state with no problem (absent, installing, ready).
func (e *voiceEngine) setState(state string) {
	e.setProblem(state, nil)
}

// setProblem moves to state (error or unsupported) for problem, which the
// page words by its code; its message is the English detail.
func (e *voiceEngine) setProblem(state string, problem *voiceProblem) {
	e.state = state
	e.problem = problem
	e.message = ""

	if problem != nil {
		e.message = problem.Message
	}

	e.lastProgress = time.Now()
	e.push()
}

// progress moves the install on, telling the page at most four times a
// second unless forced.
func (e *voiceEngine) progress(value int64, force bool) {
	e.done = min(value, e.total)

	now := time.Now()
	if !force && e.done != e.total && now.Sub(e.lastProgress) < progressEvery {
		return
	}

	e.lastProgress = now
	e.push()
}

func (e *voiceEngine) push() {
	if e.state == "" {
		return
	}

	event := map[string]any{"event": "status", "state": e.state, "downloadBytes": e.downloadBytes}
	if e.state == voiceInstalling {
		event["done"] = e.done
		event["total"] = e.total
	}

	if e.state == voiceError || e.state == voiceUnsupported {
		if e.message != "" {
			event["message"] = e.message
		}

		if e.problem != nil && e.problem.Code != "" {
			event["code"] = e.problem.Code
			for k, v := range e.problem.Fields {
				event[k] = v
			}
		}
	}

	e.send(event)
}

func (e *voiceEngine) send(event map[string]any) {
	if e.deliver != nil {
		e.deliver(event)
	}
}

// --- the lock and the folder ------------------------------------------------

// currentLock is the lock, read once; nil (with the error state set) when
// it cannot be read.
func (e *voiceEngine) currentLock() *voiceLock {
	if !e.lockLoaded {
		e.lockLoaded = true
		e.lock, e.lockErr = e.loadLock()
	}

	if e.lockErr != nil {
		e.setProblem(voiceError, problemOf(e.lockErr))

		return nil
	}

	return e.lock
}

func (e *voiceEngine) loadLock() (*voiceLock, error) {
	var (
		data []byte
		err  error
	)

	switch {
	case e.settings.LockFile != "":
		data, err = os.ReadFile(e.settings.LockFile)
	case e.files != nil:
		data, err = fs.ReadFile(e.files, voiceLockName)
	default:
		err = fs.ErrNotExist
	}

	if err != nil {
		return nil, &voiceProblem{Code: codeLockFailed, Message: "The voice lock file is missing."}
	}

	return parseVoiceLock(data, e.settings.DownloadBase)
}

// pythonBytes is the Python download's size, or 0 when the tests supply a
// Python.
func (e *voiceEngine) pythonBytes(lock *voiceLock) int64 {
	if e.settings.Python != "" || e.settings.HelperCommand != "" {
		return 0
	}

	return lock.PythonSize
}

// fullDownload is the whole install's download: Python and the helper's
// share.
func (e *voiceEngine) fullDownload(lock *voiceLock) int64 {
	return e.pythonBytes(lock) + lock.HelperBytes
}

func (e *voiceEngine) pythonExecutable() string {
	if e.settings.Python != "" {
		return e.settings.Python
	}

	return e.path("python", pythonExe)
}

func (e *voiceEngine) pythonReady(lock *voiceLock) bool {
	if e.settings.Python != "" || e.settings.HelperCommand != "" {
		return true
	}

	marker, err := os.ReadFile(e.path("python", pythonMarker))

	return err == nil && string(marker) == lock.PythonSHA256 && isExecutable(e.pythonExecutable())
}

// installComplete: Python is there and the helper has finished an install
// of this lock (its state.json), so the helper may start for a status or
// a line.
func (e *voiceEngine) installComplete(lock *voiceLock) bool {
	if e.settings.HelperCommand != "" {
		return true
	}

	if !e.pythonReady(lock) {
		return false
	}

	data, err := os.ReadFile(e.path("state.json"))
	if err != nil {
		return false
	}

	var state struct {
		Lock string `json:"lock"`
	}

	return json.Unmarshal(data, &state) == nil && state.Lock == lock.ID
}

// nearestFolder is dir or its nearest existing parent, so a refused install
// makes no folder.
func nearestFolder(dir string) string {
	for {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return dir
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return dir
		}

		dir = parent
	}
}

// writeHelper writes the helper's files and the lock into helper\, each
// only when absent or different, through a temporary file; a helper file
// a newer exe dropped is removed.
func (e *voiceEngine) writeHelper(lock *voiceLock) error {
	dir := e.path("helper")
	wanted := map[string]bool{}

	if e.files != nil {
		names, err := fs.Glob(e.files, "kinetic_voice/*.py")
		if err != nil {
			return err
		}

		for _, name := range names {
			data, err := fs.ReadFile(e.files, name)
			if err != nil {
				return err
			}

			target := filepath.Join(dir, filepath.FromSlash(name))
			wanted[path.Base(name)] = true

			if err := writeIfChanged(target, data); err != nil {
				return err
			}
		}
	}

	if err := writeIfChanged(filepath.Join(dir, voiceLockName), lock.HelperText); err != nil {
		return err
	}

	pkg := filepath.Join(dir, "kinetic_voice")
	entries, _ := os.ReadDir(pkg)

	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".py") && !wanted[entry.Name()] {
			_ = os.Remove(filepath.Join(pkg, entry.Name()))
		}
	}

	return nil
}

// writeIfChanged writes data to target unless it holds it already.
func writeIfChanged(target string, data []byte) error {
	if have, err := os.ReadFile(target); err == nil && string(have) == string(data) {
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}

	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}

	return os.Rename(tmp, target)
}

// --- the Python download ----------------------------------------------------

func (e *voiceEngine) archivePartial(lock *voiceLock) string {
	return e.path("downloads", "python-"+lock.PythonSHA256[:min(12, len(lock.PythonSHA256))]+".tar.gz.partial")
}

func (e *voiceEngine) downloadPython(run *voiceInstall, lock *voiceLock) {
	partial := e.archivePartial(lock)
	ctx, cancel := context.WithCancel(context.Background())
	run.stopDownload = cancel

	have := fileSize(partial)
	if have > 0 && have <= lock.PythonSize {
		e.logLine(fmt.Sprintf("downloading Python from %s from byte %d", lock.PythonURL, have))
	} else {
		e.logLine("downloading Python from " + lock.PythonURL)
	}

	go func() {
		var last time.Time

		err := downloadFile(ctx, e.client, lock.PythonURL, partial, lock.PythonSize, func(have int64) {
			if now := time.Now(); now.Sub(last) >= 50*time.Millisecond {
				last = now

				e.queue.post(func() {
					if e.install == run {
						e.progress(have, false)
					}
				})
			}
		})

		e.queue.post(func() { e.downloaded(run, lock, err) })
	}()
}

func (e *voiceEngine) downloaded(run *voiceInstall, lock *voiceLock, err error) {
	if e.install != run {
		return
	}

	run.stopDownload = nil

	switch {
	case run.cancelled:
		e.logLine(fmt.Sprintf("Python download cancelled at byte %d", fileSize(e.archivePartial(lock))))
		e.finishCancelled(run)
	case err != nil:
		e.failInstall(problemOf(err))
	default:
		e.unpackPython(run, lock)
	}
}

// unpackPython checks the archive and unpacks it into python\, away from
// the engine's goroutine.
func (e *voiceEngine) unpackPython(run *voiceInstall, lock *voiceLock) {
	e.progress(lock.PythonSize, true)

	archive, root := e.archivePartial(lock), e.settings.Root

	go func() {
		started := time.Now()
		err := unpackPython(archive, lock.PythonSHA256, root)

		e.queue.post(func() {
			if e.install != run {
				return
			}

			if err != nil {
				e.failInstall(problemOf(err))

				return
			}

			e.logLine(fmt.Sprintf("Python unpacked into %s in %.1f s", e.path("python"), time.Since(started).Seconds()))

			if run.cancelled {
				e.finishCancelled(run)
			} else {
				e.startHelperInstall(run, lock)
			}
		})
	}()
}

// --- the helper's install ---------------------------------------------------

func (e *voiceEngine) startHelperInstall(run *voiceInstall, lock *voiceLock) {
	if !e.startHelper(lock) {
		e.install = nil

		return
	}

	e.progress(e.pythonBytes(lock), true)
	run.helperRequest = e.request("install", map[string]any{}, nil, false, func(reply map[string]any, _ bool) {
		e.installAnswered(run, reply)
	})
}

// helperProgress is a helper progress event, on the install's scale after
// Python.
func (e *voiceEngine) helperProgress(event map[string]any) {
	if e.install == nil || e.install.helperRequest == 0 || e.lock == nil {
		return
	}

	value, okValue := asInt64(event["done"])
	whole, okWhole := asInt64(event["total"])

	if !okValue || !okWhole {
		return
	}

	base := e.pythonBytes(e.lock)
	e.total = base + whole
	e.progress(base+value, false)
}

func (e *voiceEngine) installAnswered(run *voiceInstall, reply map[string]any) {
	if e.install != run {
		return
	}

	e.install = nil
	code, _ := reply["code"].(string)
	detail := orDefault(reply["error"], "unknown error")

	switch {
	case reply["ok"] == true:
		e.setState(voiceReady)
	case code == "cancelled":
		e.finishCancelled(run)

		return
	case code == "unsupported-system":
		e.setProblem(voiceUnsupported, problemf(codeUnsupportedSystem, "Spoken lines do not run on this system (%v).",
			detail))
	case code == "download-failed":
		e.setProblem(voiceError, problemf(codeDownloadFailed, "A download failed (%v). Try again to continue it.",
			detail))
	case code == "hash-mismatch":
		e.setProblem(voiceError, problemf(codeHashMismatch, "A download did not match its checksum (%v). Try again.",
			detail))
	case code == "pip-failed":
		e.setProblem(voiceError, problemf(codePipFailed, "Installing the voice packages failed (%v).", detail))
	default:
		e.setProblem(voiceError, problemf(codeInstallFailed, "The voice install failed (%v).", detail))
	}

	if run.thenRemove {
		e.remove()
	}
}

func (e *voiceEngine) finishCancelled(run *voiceInstall) {
	e.install = nil

	if lock := e.currentLock(); lock != nil {
		e.downloadBytes = e.fullDownload(lock)
	}

	e.setState(voiceAbsent)

	if run.thenRemove {
		e.remove()
	}
}

func (e *voiceEngine) failInstall(problem *voiceProblem) {
	run := e.install
	e.install = nil
	e.logLine("install failed: " + problem.Message)
	e.setProblem(voiceError, problem)

	if run != nil && run.thenRemove {
		e.remove()
	}
}

// --- the helper process -----------------------------------------------------

// startHelper starts the helper unless it runs; false (with the error
// state set) when it cannot start.
func (e *voiceEngine) startHelper(lock *voiceLock) bool {
	if e.helper != nil {
		return true
	}

	err := os.MkdirAll(e.settings.Root, 0o755)
	if err == nil {
		err = e.writeHelper(lock)
	}

	if err == nil {
		e.helper, err = e.launchHelper()
	}

	if err != nil {
		e.setProblem(voiceError, problemf(codeHelperFailed, "The voice helper could not start: %v", err))

		return false
	}

	return true
}

// helperCommand is how the helper is run: the embedded helper under the
// private Python, in the voice folder, told where its lock is; or a test
// command line, run where the exe was started.
func (e *voiceEngine) helperCommand() *exec.Cmd {
	if e.settings.HelperCommand != "" {
		return e.plat.shell(e.settings.HelperCommand)
	}

	cmd := exec.Command(e.pythonExecutable(), "-I", "-B", e.path("helper", "kinetic_voice", "__main__.py"),
		"--root", e.settings.Root, "--lock", e.path("helper", voiceLockName))
	cmd.Dir = e.settings.Root

	return cmd
}

func (e *voiceEngine) launchHelper() (*voiceHelper, error) {
	cmd := e.helperCommand()
	e.plat.prepare(cmd)

	input, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}

	output, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	if log := e.openLog(); log != nil {
		cmd.Stderr = log
	}

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	h := &voiceHelper{cmd: cmd, input: input}
	e.logLine(fmt.Sprintf("helper started (pid %d)", cmd.Process.Pid))

	// One line a message; at the end of its output the helper's exit is
	// reported, after its last line.
	go func() {
		reader := bufio.NewReaderSize(output, 1<<16)

		for {
			line, err := reader.ReadBytes('\n')
			if message, ok := decodeJSON(line); ok {
				e.queue.post(func() { e.helperSaid(message, h) })
			}

			if err != nil {
				break
			}
		}

		waitErr := cmd.Wait()

		e.queue.post(func() { e.helperExited(h, waitErr) })
	}()

	return h, nil
}

// openLog is helper.log, kept under its limit: the helper's stderr and the
// exe's own lines about it. nil when it cannot be opened.
func (e *voiceEngine) openLog() *os.File {
	if e.log != nil {
		return e.log
	}

	name := e.path("helper.log")
	flags := os.O_WRONLY | os.O_CREATE | os.O_APPEND

	if fileSize(name) > helperLogLimit {
		flags |= os.O_TRUNC
	}

	file, err := os.OpenFile(name, flags, 0o644)
	if err != nil {
		return nil
	}

	e.log = file

	return file
}

func (e *voiceEngine) closeLog() {
	if e.log != nil {
		_ = e.log.Close()
		e.log = nil
	}
}

func (e *voiceEngine) logLine(text string) {
	if e.log != nil {
		_, _ = fmt.Fprintf(e.log, "[app %s] %s\n", time.Now().UTC().Format(time.RFC3339), text)
	}
}

// request sends one request to the helper and returns its id; reply gets
// the answer. pageID is the page's id for a request of the page's.
func (e *voiceEngine) request(op string, fields map[string]any, pageID any, forPage bool,
	reply func(map[string]any, bool)) int {
	id := e.nextRequest
	e.nextRequest++

	message := map[string]any{}
	for k, v := range fields {
		message[k] = v
	}

	message["op"] = op
	e.pending[id] = &voicePending{request: message, pageID: pageID, forPage: forPage, reply: reply}
	e.write(id, message)

	return id
}

func (e *voiceEngine) write(id int, message map[string]any) {
	if e.helper == nil {
		return
	}

	line := map[string]any{}
	for k, v := range message {
		line[k] = v
	}

	line["id"] = id

	data, err := marshalJSON(line, "")
	if err != nil {
		if p := e.pending[id]; p != nil {
			delete(e.pending, id)
			p.reply(map[string]any{"id": id, "ok": false, "code": "bad-request", "error": "the request is not JSON"},
				p.dropped)
		}

		return
	}

	// A helper that has just died fails the write; its exit follows.
	_, _ = e.helper.input.Write(append(data, '\n'))
}

func (e *voiceEngine) helperSaid(message map[string]any, from *voiceHelper) {
	if e.helper != from {
		return
	}

	if event, ok := message["event"].(string); ok {
		switch event {
		case "progress":
			e.helperProgress(message)
		case "log":
			e.logLine("helper: " + compactJSON(message))
		default:
			// Events about a request (a streamed line's chunks) go to the
			// page under the page's id.
			target, ok := asInt64(message["target"])
			p := e.pending[int(target)]

			if !ok || p == nil || !p.forPage {
				e.logLine("helper: " + compactJSON(message))

				return
			}

			if p.dropped {
				return
			}

			forward := map[string]any{}

			for k, v := range message {
				if k != "target" {
					forward[k] = v
				}
			}

			forward["id"] = p.pageID
			e.send(forward)
		}

		return
	}

	id, ok := asInt64(message["id"])
	p := e.pending[int(id)]

	if !ok || p == nil {
		e.logLine("helper answered no request: " + compactJSON(message))

		return
	}

	delete(e.pending, int(id))
	p.reply(message, p.dropped)
}

// stopHelper stops the helper; then, once it has exited, runs after.
func (e *voiceEngine) stopHelper(after func()) {
	h := e.helper
	if h == nil {
		if after != nil {
			after()
		}

		return
	}

	h.stopping = true
	h.onStopped = after
	_ = h.input.Close()
	_ = h.cmd.Process.Kill()
}

func (e *voiceEngine) helperExited(gone *voiceHelper, waitErr error) {
	if e.helper != gone {
		return
	}

	e.helper = nil

	if gone.stopping {
		e.logLine(fmt.Sprintf("helper stopped (%v)", exitText(waitErr)))
		e.failPending("helper-stopped", "The voice helper was stopped.")

		if gone.onStopped != nil {
			gone.onStopped()
		}

		return
	}

	e.crashes++
	e.logLine(fmt.Sprintf("helper exited unexpectedly (%v); crash %d", exitText(waitErr), e.crashes))

	if e.crashes == 1 && e.lock != nil && e.startHelper(e.lock) {
		// Once: the voices again, then every request still unanswered,
		// under its own id.
		unanswered := e.pendingIDs()

		for _, registration := range e.registrations {
			e.request("voice", registration, nil, false, ignoreReply)
		}

		for _, id := range unanswered {
			e.write(id, e.pending[id].request)
		}

		return
	}

	run := e.install
	e.install = nil
	text := "The voice helper stopped unexpectedly. Its log is " + e.path("helper.log") + "."
	e.failPending("helper-crashed", text)
	e.setProblem(voiceError, &voiceProblem{Code: codeHelperCrashed, Message: text})

	if run != nil && run.thenRemove {
		e.remove()
	}
}

// failPending answers every unanswered request with a failure.
func (e *voiceEngine) failPending(code, text string) {
	ids := e.pendingIDs()
	all := e.pending
	e.pending = map[int]*voicePending{}

	for _, id := range ids {
		p := all[id]
		p.reply(map[string]any{"id": id, "ok": false, "code": code, "error": text}, p.dropped)
	}
}

// pendingIDs is the unanswered requests' ids, oldest first.
func (e *voiceEngine) pendingIDs() []int {
	ids := make([]int, 0, len(e.pending))
	for id := range e.pending {
		ids = append(ids, id)
	}

	sort.Ints(ids)

	return ids
}

// --- small helpers ----------------------------------------------------------

func ignoreReply(map[string]any, bool) {}

// asInt64 reads a JSON number, as decoded (json.Number) or made here.
func asInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return n, true
		}

		f, err := v.Float64()

		return int64(f), err == nil
	case int:
		return int64(v), true
	case int64:
		return v, true
	case float64:
		return int64(v), true
	default:
		return 0, false
	}
}

func orDefault(value any, fallback string) any {
	if value == nil {
		return fallback
	}

	return value
}

func compactJSON(value any) string {
	data, err := marshalJSON(value, "")
	if err != nil {
		return fmt.Sprint(value)
	}

	return string(data)
}

func exitText(err error) string {
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ProcessState.String()
	}

	if err == nil {
		return "exit status 0"
	}

	return err.Error()
}

// serialQueue runs posted functions one at a time, in order, on a
// goroutine of its own: the engine's single thread.
type serialQueue struct {
	mu   sync.Mutex
	jobs []func()
	wake chan struct{}
}

func newSerialQueue() *serialQueue {
	q := &serialQueue{wake: make(chan struct{}, 1)}
	go q.loop()

	return q
}

// post queues f; it never blocks.
func (q *serialQueue) post(f func()) {
	q.mu.Lock()
	q.jobs = append(q.jobs, f)
	q.mu.Unlock()

	select {
	case q.wake <- struct{}{}:
	default:
	}
}

// sync runs f on the queue and waits for it.
func (q *serialQueue) sync(f func()) {
	done := make(chan struct{})
	q.post(func() {
		defer close(done)
		f()
	})
	<-done
}

func (q *serialQueue) loop() {
	for range q.wake {
		for {
			q.mu.Lock()
			if len(q.jobs) == 0 {
				q.mu.Unlock()

				break
			}

			f := q.jobs[0]
			q.jobs[0] = nil
			q.jobs = q.jobs[1:]
			q.mu.Unlock()

			q.run(f)
		}
	}
}

// run runs one job; a panic is logged and the engine carries on.
func (q *serialQueue) run(f func()) {
	defer func() {
		if r := recover(); r != nil {
			logf("voice: %v", r)
		}
	}()

	f()
}
