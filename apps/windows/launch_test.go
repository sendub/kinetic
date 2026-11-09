package main

import (
	"reflect"
	"testing"
)

func TestFileURL(t *testing.T) {
	cases := []struct{ path, want string }{
		{`C:\Users\John Doe\Games\Rainy Day\index.html`,
			"file:///C:/Users/John%20Doe/Games/Rainy%20Day/index.html"},
		{`D:\Kinetic\a#b?c\index.html`, "file:///D:/Kinetic/a%23b%3Fc/index.html"},
		{`E:\100% done\index.html`, "file:///E:/100%25%20done/index.html"},
		{`\\nas\games\Rainy Day\index.html`, "file://nas/games/Rainy%20Day/index.html"},
		{`\\nas\share#1\index.html`, "file://nas/share%231/index.html"},
		{`C:\Users\Zoë\Spiele\Über\index.html`,
			"file:///C:/Users/Zo%C3%AB/Spiele/%C3%9Cber/index.html"},
		{`C:\ゲーム\index.html`, "file:///C:/%E3%82%B2%E3%83%BC%E3%83%A0/index.html"},
		{`C:\index.html`, "file:///C:/index.html"},
	}
	for _, c := range cases {
		if got := fileURL(c.path); got != c.want {
			t.Errorf("fileURL(%q) = %q, want %q", c.path, got, c.want)
		}
	}
}

// environment is a getenv over a fixed set of variables.
func environment(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestBrowserPathsTryEdgeEverywhereThenChrome(t *testing.T) {
	got := browserPaths(environment(map[string]string{
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramFiles":      `C:\Program Files\`,
		"LOCALAPPDATA":      `C:\Users\Zoë\AppData\Local`,
	}))
	want := []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Users\Zoë\AppData\Local\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Users\Zoë\AppData\Local\Google\Chrome\Application\chrome.exe`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("browserPaths =\n%q\nwant\n%q", got, want)
	}
}

func TestBrowserPathsSkipUnsetRoots(t *testing.T) {
	got := browserPaths(environment(map[string]string{"ProgramFiles": `C:\Program Files`}))
	want := []string{
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("browserPaths = %q, want %q", got, want)
	}

	if got := browserPaths(environment(nil)); len(got) != 0 {
		t.Errorf("browserPaths with no environment = %q, want none", got)
	}
}

func TestProfileDir(t *testing.T) {
	local := environment(map[string]string{"LOCALAPPDATA": `C:\Users\Zoë\AppData\Local`})
	if got, want := profileDir(local, "rainy-day"), `C:\Users\Zoë\AppData\Local\Kinetic\Browser\rainy-day`; got != want {
		t.Errorf("profileDir = %q, want %q", got, want)
	}

	if got := profileDir(environment(nil), "rainy-day"); got != "" {
		t.Errorf("profileDir without LOCALAPPDATA = %q, want empty", got)
	}

	if got := profileDir(local, ""); got != "" {
		t.Errorf("profileDir without a story = %q, want empty", got)
	}
}

func TestBrowserArgsInEachStartMode(t *testing.T) {
	profile := `C:\Users\Zoë\AppData\Local\Kinetic\Browser\rainy-day`
	page := fileURL(`D:\Games\Rainy Day\index.html`)
	head := []string{
		`--user-data-dir=C:\Users\Zoë\AppData\Local\Kinetic\Browser\rainy-day`,
		"--app=file:///D:/Games/Rainy%20Day/index.html",
	}
	tail := []string{
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		"--hide-crash-restore-bubble",
	}
	cases := []struct {
		name  string
		start start
		mode  []string
	}{
		{"fullscreen", start{Fullscreen: true, Bounds: windowBounds{1, 2, 3, 4}}, []string{"--start-fullscreen"}},
		{"a remembered window", start{Bounds: windowBounds{Left: -1200, Top: 40, Width: 1100, Height: 640}},
			[]string{"--window-size=1100,640", "--window-position=-1200,40"}},
		{"the first window", start{Bounds: windowBounds{Left: 120, Top: 66, Width: 1296, Height: 761}, First: true},
			[]string{"--window-size=1296,761", "--window-position=120,66"}},
	}
	for _, c := range cases {
		want := append(append(append([]string{}, head...), c.mode...), tail...)
		if got := browserArgs(profile, page, c.start); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: browserArgs =\n%q\nwant\n%q", c.name, got, want)
		}
	}
}

func TestGameTitle(t *testing.T) {
	cases := []struct{ escaped, want string }{
		{"Rainy%20Day%3A%20Two%3F", "Rainy Day: Two?"},
		{"Zo%C3%AB%27s%20%22Day%22", `Zoë's "Day"`},
		{"", fallbackTitle},
		{"%20", fallbackTitle},
		{"Bad%zz", fallbackTitle},
		{"Nul%00", fallbackTitle},
	}
	for _, c := range cases {
		titleEscaped = c.escaped
		if got := gameTitle(); got != c.want {
			t.Errorf("gameTitle with %q = %q, want %q", c.escaped, got, c.want)
		}
	}

	titleEscaped = ""
}
