package main

import (
	"os"
	"testing"
)

// The check on a real PC (docs/plan.md Phase 52 item 12): the orchestrator
// cross-builds this test (GOOS=windows go test -c) and runs it there with
// KINETIC_TEST_REAL_GPU=1. Without that variable it skips: a PC may have no
// NVIDIA card.
func TestWindowsNvidiaCheckOnThisPC(t *testing.T) {
	if os.Getenv("KINETIC_TEST_REAL_GPU") == "" {
		t.Skip("set KINETIC_TEST_REAL_GPU=1 on a PC with an NVIDIA card")
	}

	const minDriver = "570.65"

	output, err := windowsVoice{}.nvidiaSmi()
	check := checkNvidia(output, err, minDriver)
	t.Logf("nvidia-smi output %q, error %v", output, err)
	t.Logf("GPU %q, driver %q, reason %q", check.GPU, check.Driver, check.Reason)

	if check.Reason != "" || check.GPU == "" || check.Driver == "" {
		t.Errorf("this PC should be supported: %+v", check)
	}

	// nvidia-smi made unavailable for this call only.
	output, err = windowsVoice{smi: "off"}.nvidiaSmi()
	check = checkNvidia(output, err, minDriver)
	t.Logf("with nvidia-smi off: error %v, reason %q", err, check.Reason)

	if check.Reason != noNvidiaReason {
		t.Errorf("with nvidia-smi off the reason is %q", check.Reason)
	}

	// The same through a program that is not there.
	output, err = windowsVoice{smi: `C:\no\such\nvidia-smi.exe`}.nvidiaSmi()
	if check = checkNvidia(output, err, minDriver); check.Reason != noNvidiaReason {
		t.Errorf("with a missing program the reason is %q", check.Reason)
	}

	// The engine's whole path, with the real card: status is not unsupported.
	e := newVoiceEngine(voiceSettings{}, nil, windowsVoice{}, nil)
	lock := &voiceLock{CudaMinDriver: minDriver}

	if e.unsupported(lock) {
		t.Errorf("the engine calls this PC unsupported: %q", e.gpu.Reason)
	}

	e = newVoiceEngine(voiceSettings{}, nil, windowsVoice{smi: "off"}, func(event map[string]any) {
		t.Logf("status event: %v", event)
	})

	if !e.unsupported(lock) || e.state != voiceUnsupported || e.message != noNvidiaReason {
		t.Errorf("with nvidia-smi off the engine state is %q %q", e.state, e.message)
	}
}
