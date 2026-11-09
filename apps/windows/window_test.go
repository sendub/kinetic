package main

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseSize(t *testing.T) {
	good := map[string]size{"1920x1080": {1920, 1080}, "64x48": {64, 48}, "1x1": {1, 1}}
	for text, want := range good {
		if got, ok := parseSize(text); !ok || got != want {
			t.Errorf("parseSize(%q) = %v, %v; want %v", text, got, ok, want)
		}
	}

	for _, text := range []string{"", "1920", "1920x", "x1080", "0x10", "10x0", "-5x10", "axb", "10x10x10", "10 x 10"} {
		if got, ok := parseSize(text); ok {
			t.Errorf("parseSize(%q) = %v, want refused", text, got)
		}
	}
}

func TestFirstContentIsTheBakedSizeElse16By9(t *testing.T) {
	defer func() { firstWindowSize = "" }()

	firstWindowSize = "1080x1920"
	if got := firstContent(); got != (size{1080, 1920}) {
		t.Errorf("firstContent with 1080x1920 baked = %v", got)
	}

	for _, baked := range []string{"", "junk"} {
		firstWindowSize = baked
		if got := firstContent(); got != (size{1280, 720}) {
			t.Errorf("firstContent with %q baked = %v, want 1280x720", baked, got)
		}
	}
}

func TestFirstBounds(t *testing.T) {
	cases := []struct {
		name           string
		work           rect
		content, frame size
		want           windowBounds
	}{
		{"1080p on a 1080p screen less its taskbar", rect{0, 0, 1920, 1040}, size{1920, 1080}, size{16, 40},
			windowBounds{138, 42, 1645, 956}},
		{"a small picture is never scaled up", rect{0, 0, 1920, 1040}, size{640, 480}, size{16, 40},
			windowBounds{632, 260, 656, 520}},
		{"a taskbar on the left offsets the work area", rect{48, 0, 1232, 800}, size{1920, 1080}, size{0, 32},
			windowBounds{80, 56, 1168, 689}},
		{"a portrait picture on a 150% laptop", rect{0, 0, 1536, 824}, size{1080, 1920}, size{16, 40},
			windowBounds{559, 33, 419, 758}},
		{"16:9 on a small laptop", rect{0, 0, 1366, 728}, size{1280, 720}, size{16, 40},
			windowBounds{116, 30, 1135, 669}},
		{"a display left of the main one", rect{-1920, 0, 1920, 1080}, size{800, 600}, size{0, 0},
			windowBounds{-1360, 240, 800, 600}},
		{"no size is 16:9", rect{0, 0, 1366, 728}, size{0, 0}, size{16, 40},
			windowBounds{116, 30, 1135, 669}},
	}
	for _, c := range cases {
		got := firstBounds(c.work, c.content, c.frame)
		if got != c.want {
			t.Errorf("%s: firstBounds = %+v, want %+v", c.name, got, c.want)
		}

		// Whatever the numbers: the content keeps its shape, and the window
		// sits inside the work area with a margin on every side.
		content := c.content
		if content.W == 0 {
			content = defaultContent
		}

		inner := size{got.Width - c.frame.W, got.Height - c.frame.H}
		if math.Abs(float64(inner.W)/float64(inner.H)-float64(content.W)/float64(content.H)) > 0.01 {
			t.Errorf("%s: content %v lost the shape of %v", c.name, inner, content)
		}

		if got.Left < c.work.Left+24 || got.Top < c.work.Top+24 ||
			got.Left+got.Width > c.work.Left+c.work.W-24 || got.Top+got.Height > c.work.Top+c.work.H-24 {
			t.Errorf("%s: %+v is not inside %+v with a margin", c.name, got, c.work)
		}
	}
}

func TestRememberedBoundsMustBeBigEnoughAndOnScreen(t *testing.T) {
	screen := rect{-1920, 0, 3840, 1080} // two 1080p displays side by side
	cases := map[windowBounds]bool{
		{100, 100, 1280, 720}:   true,
		{-1800, 50, 1280, 720}:  true, // on the left display
		{-2000, 50, 1280, 720}:  true, // partly off its left edge
		{1820, 980, 400, 300}:   true, // exactly 100x100 on screen
		{1821, 980, 400, 300}:   false,
		{3000, 100, 1280, 720}:  false, // a display that has gone
		{100, -800, 1280, 720}:  false,
		{100, 100, 199, 720}:    false, // too narrow
		{100, 100, 1280, 149}:   false, // too short
		{100, 100, 200, 150}:    true,
		{-4000, 100, 1280, 720}: false,
	}
	for b, want := range cases {
		if got := b.usable(screen); got != want {
			t.Errorf("%+v usable = %v, want %v", b, got, want)
		}
	}
}

func TestMemoryRoundTrip(t *testing.T) {
	// The profile folder does not exist before the browser's first run.
	path := memoryPath(filepath.Join(t.TempDir(), "Kinetic", "Browser", "rainy-day"))

	if got := loadMemory(path); !reflect.DeepEqual(got, windowMemory{Display: displayFullscreen}) {
		t.Errorf("no memory file = %+v, want fullscreen with no bounds", got)
	}

	saved := windowMemory{Display: displayWindow, Bounds: &windowBounds{-1500, 60, 1100, 640}}
	if err := saveMemory(path, saved); err != nil {
		t.Fatal(err)
	}

	if got := loadMemory(path); !reflect.DeepEqual(got, saved) {
		t.Errorf("loadMemory = %+v (%+v), want %+v", got, got.Bounds, saved)
	}

	saved = windowMemory{Display: displayFullscreen, Bounds: &windowBounds{10, 20, 300, 200}}
	if err := saveMemory(path, saved); err != nil {
		t.Fatal(err)
	}

	if got := loadMemory(path); !reflect.DeepEqual(got, saved) {
		t.Errorf("after a second save loadMemory = %+v, want %+v", got, saved)
	}

	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 || entries[0].Name() != memoryFile {
		t.Errorf("the profile folder holds %v, want only %s", entries, memoryFile)
	}

	data, _ := os.ReadFile(path)
	if want := `{"display":"fullscreen","bounds":{"left":10,"top":20,"width":300,"height":200}}`; string(data) != want {
		t.Errorf("the file reads %s, want %s", data, want)
	}
}

func TestBrokenMemoryStartsFullscreen(t *testing.T) {
	path := filepath.Join(t.TempDir(), memoryFile)
	for _, text := range []string{"", "{", "[]", `{"display":"maximized"}`, `{"display":7}`} {
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}

		if got := loadMemory(path); got.Display != displayFullscreen || got.Bounds != nil {
			t.Errorf("memory %q = %+v, want fullscreen with no bounds", text, got)
		}
	}
}

func TestPlanStartOpensTheWayTheReaderLeftIt(t *testing.T) {
	screen := rect{0, 0, 1920, 1080}
	work := rect{0, 0, 1920, 1040}

	var frames []size

	first := func(frame size) windowBounds {
		frames = append(frames, frame)

		return firstBounds(work, size{1920, 1080}, frame)
	}
	kept := windowBounds{200, 100, 1100, 640}
	gone := windowBounds{2500, 100, 1100, 640}

	cases := []struct {
		name   string
		memory windowMemory
		want   start
	}{
		{"no memory", windowMemory{}, start{Fullscreen: true}},
		{"left fullscreen", windowMemory{Display: displayFullscreen, Bounds: &kept}, start{Fullscreen: true}},
		{"left as a window", windowMemory{Display: displayWindow, Bounds: &kept}, start{Bounds: kept}},
		{"a window on a display that has gone", windowMemory{Display: displayWindow, Bounds: &gone},
			start{Bounds: windowBounds{138, 42, 1645, 956}, First: true}},
		{"a window never placed", windowMemory{Display: displayWindow},
			start{Bounds: windowBounds{138, 42, 1645, 956}, First: true}},
	}
	for _, c := range cases {
		if got := planStart(c.memory, screen, first); got != c.want {
			t.Errorf("%s: planStart = %+v, want %+v", c.name, got, c.want)
		}
	}

	if want := []size{estimatedFrame, estimatedFrame}; !reflect.DeepEqual(frames, want) {
		t.Errorf("first window frames %v, want %v", frames, want)
	}
}
