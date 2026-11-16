package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	noGPUMessage     = "Spoken lines need an NVIDIA graphics card. This computer doesn't have one."
	oldDriverMessage = "Spoken lines need NVIDIA driver 570.65 or later. Update the graphics driver to use them."
)

func TestCheckNvidia(t *testing.T) {
	for _, c := range []struct {
		name, output string
		err          error
		min          string
		gpu, driver  string
		reason       string
	}{
		{"nvidia-smi missing", "", errors.New("not found"), "570.65", "", "", noGPUMessage},
		{"nvidia-smi failed", "NVIDIA-SMI has failed", errors.New("exit status 9"), "570.65", "", "", noGPUMessage},
		{"no output", "", nil, "570.65", "", "", noGPUMessage},
		{"blank lines", "\r\n\n", nil, "570.65", "", "", noGPUMessage},
		{"no devices", "No devices were found\n", nil, "570.65", "", "", noGPUMessage},
		{"good driver", "NVIDIA GeForce RTX 5090, 572.83\n", nil, "570.65", "NVIDIA GeForce RTX 5090", "572.83", ""},
		{"windows line ends", "NVIDIA GeForce RTX 5090, 572.83\r\n", nil, "570.65", "NVIDIA GeForce RTX 5090", "572.83", ""},
		{"exactly the minimum", "NVIDIA GeForce RTX 5090, 570.65\n", nil, "570.65", "NVIDIA GeForce RTX 5090", "570.65", ""},
		{"old driver", "NVIDIA GeForce GTX 1060, 566.36\n", nil, "570.65", "NVIDIA GeForce GTX 1060", "566.36", oldDriverMessage},
		{"compared by number not text", "NVIDIA GeForce RTX 5090, 1000.1\n", nil, "570.65", "NVIDIA GeForce RTX 5090", "1000.1", ""},
		{"older by a minor", "NVIDIA GeForce RTX 5090, 570.9\n", nil, "570.65", "NVIDIA GeForce RTX 5090", "570.9", oldDriverMessage},
		{"a comma in the name", "NVIDIA RTX A6000, Ada, 560.1\n", nil, "570.65", "NVIDIA RTX A6000, Ada", "560.1", oldDriverMessage},
		{"second card, first line counts", "NVIDIA GeForce RTX 5090, 572.83\nNVIDIA GeForce RTX 3060, 572.83\n", nil, "570.65",
			"NVIDIA GeForce RTX 5090", "572.83", ""},
		{"a driver it cannot read still counts as a card", "NVIDIA GeForce RTX 5090, [N/A]\n", nil, "570.65",
			"NVIDIA GeForce RTX 5090", "", ""},
		{"no minimum in the lock", "NVIDIA GeForce GTX 1060, 400.1\n", nil, "", "NVIDIA GeForce GTX 1060", "400.1", ""},
	} {
		got := checkNvidia(c.output, c.err, c.min)
		if got.GPU != c.gpu || got.Driver != c.driver || got.Reason != c.reason {
			t.Errorf("%s: checkNvidia = %+v, want GPU %q driver %q reason %q", c.name, got, c.gpu, c.driver, c.reason)
		}
	}
}

// fakeSmi writes a shell script standing in for nvidia-smi.
func fakeSmi(t *testing.T, body string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "nvidia-smi")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	return path
}

func TestRunNvidiaSmi(t *testing.T) {
	prepared := 0
	prepare := func(*exec.Cmd) { prepared++ }

	smi := fakeSmi(t, `echo "$@" > "$0.args"; echo "NVIDIA GeForce RTX 5090, 572.83"`)

	out, err := runNvidiaSmi(smi, prepare, 5*time.Second)
	if err != nil || out != "NVIDIA GeForce RTX 5090, 572.83\n" {
		t.Fatalf("runNvidiaSmi = %q, %v", out, err)
	}

	if prepared != 1 {
		t.Errorf("the command was prepared (hidden) %d times, want 1", prepared)
	}

	args, _ := os.ReadFile(smi + ".args")
	if strings.TrimSpace(string(args)) != "--query-gpu=name,driver_version --format=csv,noheader" {
		t.Errorf("arguments = %q", args)
	}

	if _, err := runNvidiaSmi(fakeSmi(t, "exit 9"), prepare, 5*time.Second); err == nil {
		t.Error("a failing nvidia-smi gave no error")
	}

	if _, err := runNvidiaSmi(filepath.Join(t.TempDir(), "missing"), prepare, 5*time.Second); err == nil {
		t.Error("a missing nvidia-smi gave no error")
	}

	if _, err := runNvidiaSmi("", prepare, 5*time.Second); err == nil {
		t.Error("no nvidia-smi path gave no error")
	}

	start := time.Now()
	if _, err := runNvidiaSmi(fakeSmi(t, "exec sleep 5"), prepare, 150*time.Millisecond); err == nil ||
		time.Since(start) > 3*time.Second {
		t.Errorf("a hung nvidia-smi was not cut off (%v after %v)", err, time.Since(start))
	}
}
