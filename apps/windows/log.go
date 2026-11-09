package main

// The exe's log, kinetic-host.log in the game's data folder: one run's
// startup, the runtime it found, the results of creating the web view, the
// mode switches and the page's messages, for a reader reporting a problem.

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	logMu  sync.Mutex
	logOut io.Writer
)

// logf adds a timestamped line to the log; nothing before openLog.
func logf(format string, args ...any) {
	logMu.Lock()
	defer logMu.Unlock()

	if logOut == nil {
		return
	}

	_, _ = fmt.Fprintf(logOut, "%s %s\n", time.Now().Format("2006-01-02 15:04:05.000"), fmt.Sprintf(format, args...))
}

// openLog starts a fresh log in dir (made if missing) and returns what
// closes it; with no log file the lines go nowhere.
func openLog(dir string) func() {
	if dir == "" || os.MkdirAll(dir, 0o755) != nil {
		return func() {}
	}

	file, err := os.Create(filepath.Join(dir, logFile))
	if err != nil {
		return func() {}
	}

	logMu.Lock()
	logOut = file
	logMu.Unlock()

	return func() {
		logMu.Lock()
		logOut = nil
		logMu.Unlock()

		_ = file.Close()
	}
}
