package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestLogStartsFreshEachRun(t *testing.T) {
	logf("before the log opens: %d", 1) // goes nowhere

	dir := filepath.Join(t.TempDir(), "Kinetic", "WebView2", "rainy-day")
	closeLog := openLog(dir)
	logf("runtime %s at %s", "142.0.3595.53", `C:\x`)
	closeLog()
	logf("after it closes")

	closeLog = openLog(dir)
	logf("second run")
	closeLog()

	data, err := os.ReadFile(filepath.Join(dir, logFile))
	if err != nil {
		t.Fatal(err)
	}

	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	stamp := regexp.MustCompile(`^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} second run$`)

	if len(lines) != 1 || !stamp.MatchString(lines[0]) {
		t.Errorf("the log reads %q, want one timestamped line from the second run", lines)
	}

	if closeNothing := openLog(""); closeNothing == nil {
		t.Error("openLog with no folder returned no closer")
	}
}
