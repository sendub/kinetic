package main

import (
	"slices"
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

func TestGameTitleIsTheSettingsTitleElseKinetic(t *testing.T) {
	defer func() { settings = hostSettings{} }()

	cases := []struct{ title, want string }{
		{"Rainy Day: Two?", "Rainy Day: Two?"},
		{`Zoë's "Day" 100%`, `Zoë's "Day" 100%`},
		{"", fallbackTitle},
		{"  ", fallbackTitle},
		{"Nul\x00", fallbackTitle},
	}
	for _, c := range cases {
		settings = hostSettings{StoryID: "rainy", Title: c.title}
		if got := gameTitle(); got != c.want {
			t.Errorf("gameTitle with %q = %q, want %q", c.title, got, c.want)
		}
	}
}

func TestTheWebViewIsCreatedWithAutoplayAllowed(t *testing.T) {
	const flag = "--autoplay-policy=no-user-gesture-required"

	got := webViewEnvironment(environment(nil))
	want := []envVar{
		{"WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "FF000000"},
		{"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", flag},
	}

	if !slices.Equal(got, want) {
		t.Errorf("webViewEnvironment = %q, want %q", got, want)
	}
}

func TestTheAutoplayFlagKeepsTheReadersOwnArguments(t *testing.T) {
	cases := []struct{ theirs, want string }{
		{"--remote-debugging-port=9222", "--remote-debugging-port=9222 --autoplay-policy=no-user-gesture-required"},
		{"  --lang=de  ", "--lang=de --autoplay-policy=no-user-gesture-required"},
		// Their own autoplay policy stands.
		{"--autoplay-policy=user-gesture-required", "--autoplay-policy=user-gesture-required"},
		{"--lang=de --autoplay-policy=no-user-gesture-required", "--lang=de --autoplay-policy=no-user-gesture-required"},
	}
	for _, c := range cases {
		env := environment(map[string]string{"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS": c.theirs})
		if got := webViewEnvironment(env)[1]; got != (envVar{"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", c.want}) {
			t.Errorf("with %q set: %q, want %q", c.theirs, got, c.want)
		}
	}
}
