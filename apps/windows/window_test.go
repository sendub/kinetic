package main

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestFirstContentIsTheSettingsSizeElse16By9(t *testing.T) {
	defer func() { settings = hostSettings{} }()

	settings = hostSettings{StoryID: "rainy", WindowSize: &windowSize{1080, 1920}}
	if got := firstContent(); got != (size{1080, 1920}) {
		t.Errorf("firstContent with 1080x1920 = %v", got)
	}

	for _, w := range []*windowSize{nil, {0, 10}, {10, 0}} {
		settings = hostSettings{StoryID: "rainy", WindowSize: w}
		if got := firstContent(); got != (size{1280, 720}) {
			t.Errorf("firstContent with %v = %v, want 1280x720", w, got)
		}
	}
}

func TestFirstBounds(t *testing.T) {
	cases := []struct {
		name           string
		work           rect
		content, frame size
		scale          float64
		want           windowBounds
	}{
		{"1080p on a 1080p screen less its taskbar", rect{0, 0, 1920, 1040}, size{1920, 1080}, size{16, 39}, 1,
			windowBounds{137, 42, 1647, 956}},
		{"a small picture is never scaled up", rect{0, 0, 1920, 1040}, size{640, 480}, size{16, 39}, 1,
			windowBounds{632, 261, 656, 519}},
		{"a taskbar on the left offsets the work area", rect{48, 0, 1232, 800}, size{1920, 1080}, size{0, 32}, 1,
			windowBounds{80, 56, 1168, 689}},
		{"a portrait picture", rect{0, 0, 1536, 824}, size{1080, 1920}, size{16, 39}, 1,
			windowBounds{558, 33, 420, 758}},
		{"16:9 on a small laptop", rect{0, 0, 1366, 728}, size{1280, 720}, size{16, 39}, 1,
			windowBounds{115, 30, 1137, 669}},
		{"a display left of the main one", rect{-1920, 0, 1920, 1080}, size{800, 600}, size{0, 0}, 1,
			windowBounds{-1360, 240, 800, 600}},
		{"no size is 16:9", rect{0, 0, 1366, 728}, size{0, 0}, size{16, 39}, 1,
			windowBounds{115, 30, 1137, 669}},
		{"1080p on a 150% laptop: CSS pixels, so it is scaled down", rect{0, 0, 1920, 1032}, size{1920, 1080},
			size{22, 57}, 1.5, windowBounds{156, 42, 1608, 949}},
		{"a small picture at 200% covers twice the pixels, never more", rect{0, 0, 3840, 2112}, size{640, 480},
			size{32, 76}, 2, windowBounds{1264, 538, 1312, 1036}},
		{"no scale is 100%", rect{0, 0, 1920, 1040}, size{640, 480}, size{16, 39}, 0,
			windowBounds{632, 261, 656, 519}},
	}
	for _, c := range cases {
		got := firstBounds(c.work, c.content, c.frame, c.scale)
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

		margin := int(24 * math.Max(1, c.scale))
		if got.Left < c.work.Left+margin || got.Top < c.work.Top+margin ||
			got.Left+got.Width > c.work.Left+c.work.W-margin || got.Top+got.Height > c.work.Top+c.work.H-margin {
			t.Errorf("%s: %+v is not inside %+v with a %d margin", c.name, got, c.work, margin)
		}
	}
}

// Two 1080p displays side by side, the left one at 150%.
var (
	leftMonitor  = monitor{Area: rect{-1920, 0, 1920, 1080}, Work: rect{-1920, 0, 1920, 1032}, DPI: 144}
	rightMonitor = monitor{Area: rect{0, 0, 1920, 1080}, Work: rect{0, 0, 1920, 1040}, DPI: 96}
)

func TestRememberedBoundsMustBeBigEnoughAndOnAMonitor(t *testing.T) {
	cases := map[windowBounds]bool{
		{100, 100, 1280, 720}:  true,
		{1820, 940, 400, 300}:  true, // exactly 100x100 in the work area
		{1821, 940, 400, 300}:  false,
		{1820, 941, 400, 300}:  false, // the rest is under the taskbar
		{100, -800, 1280, 720}: false,
		{100, 100, 199, 720}:   false, // too narrow
		{100, 100, 1280, 149}:  false, // too short
		{100, 100, 200, 150}:   true,
		{-1800, 50, 1280, 720}: false, // on the other display
	}
	for b, want := range cases {
		if got := b.usableOn(rightMonitor); got != want {
			t.Errorf("%+v usableOn the right display = %v, want %v", b, got, want)
		}
	}
}

func TestMonitorForIsTheDisplayHoldingMostOfTheWindow(t *testing.T) {
	monitors := []monitor{rightMonitor, leftMonitor}
	cases := []struct {
		bounds windowBounds
		want   int
		ok     bool
	}{
		{windowBounds{100, 100, 1280, 720}, 0, true},
		{windowBounds{-1800, 50, 1280, 720}, 1, true},
		{windowBounds{-600, 50, 1000, 720}, 1, true}, // 600 across on the left, 400 on the right
		{windowBounds{-400, 50, 1000, 720}, 0, true},
		{windowBounds{2500, 100, 1100, 640}, -1, false}, // a display that has gone
		{windowBounds{100, 100, 150, 100}, -1, false},
	}
	for _, c := range cases {
		got, ok := monitorFor(c.bounds, monitors)
		if got != c.want || ok != c.ok {
			t.Errorf("monitorFor(%+v) = %d, %v; want %d, %v", c.bounds, got, ok, c.want, c.ok)
		}
	}

	if _, ok := monitorFor(windowBounds{100, 100, 1280, 720}, nil); ok {
		t.Error("monitorFor with no monitors found one")
	}
}

func TestWindowedOnKeepsTheRememberedWindowOnItsMonitor(t *testing.T) {
	content, frame := size{1920, 1080}, size{22, 57}
	kept := windowBounds{-1700, 80, 1200, 700}

	if got := windowedOn(leftMonitor, &kept, content, frame); got != kept {
		t.Errorf("windowedOn the window's own monitor = %+v, want %+v", got, kept)
	}

	first := firstBounds(rightMonitor.Work, content, frame, 1)
	if got := windowedOn(rightMonitor, &kept, content, frame); got != first {
		t.Errorf("windowedOn another monitor = %+v, want the first window %+v", got, first)
	}

	if got := windowedOn(leftMonitor, nil, content, frame); got != firstBounds(leftMonitor.Work, content, frame, 1.5) {
		t.Errorf("windowedOn with no memory = %+v, want the first window at 150%%", got)
	}
}

func TestMemoryRoundTrip(t *testing.T) {
	// The data folder does not exist before WebView2's first run.
	path := memoryPath(filepath.Join(t.TempDir(), "Kinetic", "WebView2", "rainy-day"))

	if got := loadMemory(path); !reflect.DeepEqual(got, windowMemory{Display: displayFullscreen}) {
		t.Errorf("no memory file = %+v, want fullscreen with no bounds", got)
	}

	saved := windowMemory{Display: displayWindow, Bounds: &windowBounds{-1500, 60, 1100, 640}, Maximized: true}
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
		t.Errorf("the data folder holds %v, want only %s", entries, memoryFile)
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
	monitors := []monitor{leftMonitor, rightMonitor}
	primary := 1
	content := size{1920, 1080}

	var dpis []int

	frame := func(dpi int) size {
		dpis = append(dpis, dpi)

		return size{16 * dpi / 96, 39 * dpi / 96}
	}
	firstRight := firstBounds(rightMonitor.Work, content, size{16, 39}, 1)
	firstLeft := firstBounds(leftMonitor.Work, content, size{24, 58}, 1.5)
	onRight := windowBounds{200, 100, 1100, 640}
	onLeft := windowBounds{-1700, 80, 1200, 700}
	gone := windowBounds{2500, 100, 1100, 640}

	cases := []struct {
		name   string
		memory windowMemory
		want   start
		dpis   []int
	}{
		{"no memory: fullscreen on the primary display", windowMemory{},
			start{Fullscreen: true, Monitor: rightMonitor, Normal: firstRight, First: true}, []int{96}},
		{"left fullscreen with its window on the other display: fullscreen there",
			windowMemory{Display: displayFullscreen, Bounds: &onLeft, Maximized: true},
			start{Fullscreen: true, Monitor: leftMonitor, Normal: onLeft}, nil},
		{"left as a window", windowMemory{Display: displayWindow, Bounds: &onRight},
			start{Monitor: rightMonitor, Normal: onRight}, nil},
		{"left as a maximized window on the other display",
			windowMemory{Display: displayWindow, Bounds: &onLeft, Maximized: true},
			start{Monitor: leftMonitor, Normal: onLeft, Maximized: true}, nil},
		{"a window on a display that has gone", windowMemory{Display: displayWindow, Bounds: &gone, Maximized: true},
			start{Monitor: rightMonitor, Normal: firstRight, First: true}, []int{96}},
		{"a window never placed", windowMemory{Display: displayWindow},
			start{Monitor: rightMonitor, Normal: firstRight, First: true}, []int{96}},
	}
	for _, c := range cases {
		dpis = nil
		if got := planStart(c.memory, monitors, primary, content, frame); got != c.want {
			t.Errorf("%s: planStart =\n%+v, want\n%+v", c.name, got, c.want)
		}

		if !reflect.DeepEqual(dpis, c.dpis) {
			t.Errorf("%s: frames asked for DPIs %v, want %v", c.name, dpis, c.dpis)
		}
	}

	// The first window on a primary display at 150% uses that DPI's frame.
	dpis = nil
	if got := planStart(windowMemory{Display: displayWindow}, monitors, 0, content, frame); got.Normal != firstLeft {
		t.Errorf("first window on a 150%% primary = %+v, want %+v", got.Normal, firstLeft)
	}

	// No monitor listed: the fallback display.
	got := planStart(windowMemory{}, nil, 0, content, frame)
	if got.Monitor != fallbackMonitor || !got.Fullscreen || !got.First {
		t.Errorf("planStart with no monitors = %+v, want fullscreen on the fallback display", got)
	}
}

func TestStyleForSwapsTheFrameAndKeepsTheRest(t *testing.T) {
	const visible = 0x10000000

	framed := uint32(wsOverlappedWindow | wsClipChildren | visible)
	frameless := uint32(wsPopup | wsClipChildren | visible)

	if got := styleFor(displayFullscreen, framed); got != frameless {
		t.Errorf("framed to fullscreen = %#x, want %#x", got, frameless)
	}

	if got := styleFor(displayWindow, frameless); got != framed {
		t.Errorf("frameless to a window = %#x, want %#x", got, framed)
	}

	if got := styleFor(displayWindow, framed); got != framed {
		t.Errorf("a window to a window = %#x, want it unchanged", got)
	}
}
