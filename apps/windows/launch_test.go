package main

import (
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

func TestDataDir(t *testing.T) {
	local := environment(map[string]string{"LOCALAPPDATA": `C:\Users\Zoë\AppData\Local\`})
	if got, want := dataDir(local, "rainy-day"), `C:\Users\Zoë\AppData\Local\Kinetic\WebView2\rainy-day`; got != want {
		t.Errorf("dataDir = %q, want %q", got, want)
	}

	if got := dataDir(environment(nil), "rainy-day"); got != "" {
		t.Errorf("dataDir without LOCALAPPDATA = %q, want empty", got)
	}

	if got := dataDir(local, ""); got != "" {
		t.Errorf("dataDir without a story = %q, want empty", got)
	}
}

func TestEachGameHasItsOwnWindowClassAndMutex(t *testing.T) {
	if got, want := windowClass("rainy-day"), "KineticGame-rainy-day"; got != want {
		t.Errorf("windowClass = %q, want %q", got, want)
	}

	if got, want := mutexName("rainy-day"), `Local\KineticGame-rainy-day`; got != want {
		t.Errorf("mutexName = %q, want %q", got, want)
	}

	if windowClass("a") == windowClass("b") || mutexName("a") == mutexName("b") {
		t.Error("two stories share a window class or mutex")
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
