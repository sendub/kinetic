package main

// Spoken lines on Windows: the engine's few system calls (free space,
// hidden helper processes, the test helper command through cmd.exe) and
// the bridge between the page and the engine. The engine runs on its own
// goroutine; its events reach the UI thread as wmAppVoice, where every
// WebView2 call is made.

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var procGetDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")

// windowsVoice is the engine's voicePlatform on Windows. smi is the test
// override for nvidia-smi (voiceSettings.NvidiaSmi).
type windowsVoice struct {
	smi string
}

// nvidiaSmiTimeout is how long the exe waits for nvidia-smi, which takes
// a moment to wake the driver.
const nvidiaSmiTimeout = 15 * time.Second

// nvidiaSmi runs nvidia-smi (the test override, else the one on the PATH,
// else the one in the system folder, where the driver installs it), with
// no console window.
func (w windowsVoice) nvidiaSmi() (string, error) {
	exe := w.smi

	switch exe {
	case "off":
		return "", errors.New("nvidia-smi is switched off")
	case "":
		exe, _ = exec.LookPath("nvidia-smi")
		if exe == "" {
			system := winJoin(os.Getenv("SystemRoot"), "System32", "nvidia-smi.exe")
			if _, err := os.Stat(system); err == nil {
				exe = system
			}
		}
	}

	return runNvidiaSmi(exe, w.prepare, nvidiaSmiTimeout)
}

// freeBytes is GetDiskFreeSpaceExW's space free to this user on dir's
// volume (quotas counted).
func (windowsVoice) freeBytes(dir string) (int64, bool) {
	var available, total, free uint64

	ok, _, _ := procGetDiskFreeSpaceEx.Call(uintptr(unsafe.Pointer(utf16(dir))), uintptr(unsafe.Pointer(&available)),
		uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&free)))
	if ok == 0 {
		return 0, false
	}

	return int64(available), true
}

// prepare runs the helper with no console window (the exe is a GUI
// program, so a console program would otherwise open one).
func (windowsVoice) prepare(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}

	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= createNoWindow
}

// shell runs a test helper command line with cmd.exe, as given.
func (windowsVoice) shell(command string) *exec.Cmd {
	shell := os.Getenv("ComSpec")
	if shell == "" {
		shell = winJoin(os.Getenv("SystemRoot"), "System32", "cmd.exe")
	}

	cmd := exec.Command(shell)
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `"` + shell + `" /d /s /c "` + command + `"`}

	return cmd
}

// voiceBridge is the game's side of the voice bridge.
type voiceBridge struct {
	// voice is the engine; nil when the exe offers no voice.
	voice *voiceEngine
	// out holds the engine's events until the UI thread takes them.
	outMu sync.Mutex
	out   []map[string]any
	// held is the latest status that found no web view (UI thread only),
	// given to the page before its next voice message goes to the engine.
	held        map[string]any
	onVoiceSent *comHandler
}

// startVoice makes the voice engine when the exe carries the helper (or a
// test names a helper command). Call it once the window exists.
func (g *game) startVoice() {
	cwd, _ := os.Getwd()
	settings := voiceSettingsFrom(os.Getenv, cwd)

	switch {
	case settings.Root == "":
		logf("voice: not offered (no LOCALAPPDATA)")

		return
	case embeddedVoice == nil && settings.HelperCommand == "":
		logf("voice: not offered (built without the voice helper)")

		return
	}

	hwnd := g.hwnd
	g.onVoiceSent = newHandler("voice event", iidExecuteScriptCompleted, func(a, _ uintptr) {
		if hr := int32(a); hr < 0 {
			logf("giving the page a voice event: %s", hresult(hr))
		}
	})
	g.voice = newVoiceEngine(settings, embeddedVoice, windowsVoice{smi: settings.NvidiaSmi}, func(event map[string]any) {
		g.outMu.Lock()
		g.out = append(g.out, event)
		first := len(g.out) == 1
		g.outMu.Unlock()

		if first {
			postMessage(hwnd, wmAppVoice, 0)
		}
	})
	logf("voice: offered, voice folder %s", settings.Root)
}

// deliverVoice gives the page the engine's events (wmAppVoice).
func (g *game) deliverVoice() {
	g.outMu.Lock()
	events := g.out
	g.out = nil
	g.outMu.Unlock()

	for _, event := range events {
		if g.view == nil {
			if event["event"] == "status" {
				g.held = event
			}

			continue
		}

		g.runVoiceScript(event)
	}
}

func (g *game) runVoiceScript(event map[string]any) {
	logResult("giving the page a voice event", g.view.call(wvExecuteScript,
		uintptr(unsafe.Pointer(utf16(voiceScript(event)))), uintptr(unsafe.Pointer(g.onVoiceSent))))
}

// voiceMessage hands a voice message from the game's page to the engine.
func (g *game) voiceMessage(message map[string]any) {
	if g.voice == nil {
		logf("ignored a voice message: this exe offers no voice")

		return
	}

	if op := message["op"]; op != "speak" && op != "drop" && op != "voice" {
		logf("voice: the page sent %v", op)
	}

	if g.held != nil && g.view != nil {
		g.runVoiceScript(g.held)
		g.held = nil
	}

	g.voice.receive(message)
}

// stopVoice stops the helper and any download: the game is closing.
func (g *game) stopVoice() {
	if g.voice != nil {
		g.voice.shutdown()
	}
}
