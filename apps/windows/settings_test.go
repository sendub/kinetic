package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseSettingsReadsWhatKineticAppsWrites(t *testing.T) {
	// The bytes kinetic_extract/apps.py writes (settings_json), compact and
	// sorted, with a title JSON escapes.
	data := []byte(`{"kineticVersion":"1.12.0","storyId":"rainy_day-2",` +
		`"title":"Zoë's \"Day\" 100% \u2603","windowSize":{"height":1080,"width":1920}}`)
	want := hostSettings{
		StoryID: "rainy_day-2", Title: `Zoë's "Day" 100% ☃`,
		WindowSize: &windowSize{1920, 1080}, KineticVersion: "1.12.0",
	}

	if got := parseSettings(data); !reflect.DeepEqual(got, want) {
		t.Errorf("parseSettings = %+v, want %+v", got, want)
	}

	noSize := parseSettings([]byte(`{"storyId":"rainy","title":"Rainy","kineticVersion":"1.12.0"}`))
	if noSize.WindowSize != nil || noSize.StoryID != "rainy" || noSize.Title != "Rainy" {
		t.Errorf("parseSettings without a size = %+v", noSize)
	}
}

func TestParseSettingsGivesNothingForABadResource(t *testing.T) {
	for _, data := range []string{
		"", "{}", "null", "not json", `{"storyId": 7}`, `{"storyId": ""}`,
		`{"storyId": "Rainy Day"}`, `{"storyId": "../up"}`, `{"storyId": "-lead"}`,
		`{"storyId": "` + strings.Repeat("a", 65) + `"}`,
	} {
		if got := parseSettings([]byte(data)); !reflect.DeepEqual(got, hostSettings{}) {
			t.Errorf("parseSettings(%q) = %+v, want empty", data, got)
		}
	}
}

func TestParseSettingsDropsAnEmptyWindowSize(t *testing.T) {
	for _, size := range []string{`{"width":0,"height":10}`, `{"width":10,"height":-1}`, `{}`} {
		got := parseSettings([]byte(`{"storyId":"rainy","windowSize":` + size + `}`))
		if got.StoryID != "rainy" || got.WindowSize != nil {
			t.Errorf("windowSize %s: %+v", size, got)
		}
	}
}

func TestSelfCheckPath(t *testing.T) {
	cases := []struct {
		args     []string
		path     string
		selfTest bool
	}{
		{nil, "", false},
		{[]string{"--other"}, "", false},
		{[]string{"--self-check", `C:\out dir\o.json`}, `C:\out dir\o.json`, true},
		{[]string{"x", "--self-check=o.json"}, "o.json", true},
		{[]string{"--self-check"}, "", true},
	}
	for _, c := range cases {
		path, ok := selfCheckPath(c.args)
		if path != c.path || ok != c.selfTest {
			t.Errorf("selfCheckPath(%q) = %q, %v; want %q, %v", c.args, path, ok, c.path, c.selfTest)
		}
	}
}

func TestSelfCheckWritesTheSettingsAsJSON(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out.json")
	s := hostSettings{StoryID: "rainy", Title: "Rainy Day", WindowSize: &windowSize{64, 48}, KineticVersion: "1.12.0"}

	if code := selfCheck(out, s); code != 0 {
		t.Fatalf("selfCheck = %d", code)
	}

	var got map[string]any
	data, _ := os.ReadFile(out)
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("%s: %v", data, err)
	}

	want := map[string]any{
		"host": "windows", "storyId": "rainy", "title": "Rainy Day",
		"windowSize": map[string]any{"width": 64.0, "height": 48.0}, "kineticVersion": "1.12.0",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("self-check wrote %v, want %v", got, want)
	}

	// No size, and the settings of an exe no game was written into: nulls
	// and empty strings, still written.
	if code := selfCheck(out, hostSettings{}); code != 0 {
		t.Fatalf("selfCheck of empty settings = %d", code)
	}

	data, _ = os.ReadFile(out)
	if string(data) != `{"host":"windows","storyId":"","title":"","windowSize":null,"kineticVersion":""}`+"\n" {
		t.Errorf("empty self-check wrote %s", data)
	}
}

func TestSelfCheckFailures(t *testing.T) {
	if code := selfCheck("", hostSettings{}); code != 2 {
		t.Errorf("selfCheck with no FILE = %d, want 2", code)
	}

	if code := selfCheck(filepath.Join(t.TempDir(), "missing", "out.json"), hostSettings{}); code != 1 {
		t.Errorf("selfCheck into a missing folder = %d, want 1", code)
	}
}
