package main

import (
	"reflect"
	"testing"
)

func TestParseVersion(t *testing.T) {
	if got, ok := parseVersion(" 120.0.2210.91 "); !ok || got != [4]int{120, 0, 2210, 91} {
		t.Errorf("parseVersion = %v, %v", got, ok)
	}

	for _, text := range []string{"", "120", "120.0.2210", "120.0.2210.91.1", "a.b.c.d", "120.0.-1.0", "120..2210.91"} {
		if got, ok := parseVersion(text); ok {
			t.Errorf("parseVersion(%q) = %v, want refused", text, got)
		}
	}
}

func TestSupportedVersion(t *testing.T) {
	cases := map[string]bool{
		"86.0.616.0":     true,
		"86.0.616.1":     true,
		"86.0.617.0":     true,
		"87.0.0.0":       true,
		"142.0.3595.53":  true,
		"86.0.615.99":    false,
		"85.9.9999.9999": false,
		"0.0.0.0":        false, // Microsoft's "not installed"
		"":               false,
		"Application":    false,
	}
	for text, want := range cases {
		if got := supportedVersion(text); got != want {
			t.Errorf("supportedVersion(%q) = %v, want %v", text, got, want)
		}
	}
}

func TestRuntimeCandidatesInTheLoadersOrder(t *testing.T) {
	env := environment(map[string]string{
		"ProgramFiles(x86)": `C:\Program Files (x86)`,
		"ProgramFiles":      `C:\Program Files`,
		"LOCALAPPDATA":      `C:\Users\Zoë\AppData\Local`,
	})
	readings := []runtimeReading{
		{View: "HKLM 32-bit", Folder: `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\142.0.3595.53\`,
			Version: "142.0.3595.53"},
		{View: "HKLM 64-bit"},
		{View: "HKCU", PerUser: true, Version: "141.0.1.2", Location: `C:\Users\Zoë\AppData\Local\Microsoft\EdgeWebView\Application`},
	}
	got := runtimeCandidates(readings, env)
	want := []runtimeCandidate{
		{`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\142.0.3595.53`, "142.0.3595.53",
			`HKLM 32-bit ClientState\EBWebView`},
		{`C:\Program Files (x86)\Microsoft\EdgeWebView\Application\142.0.3595.53`, "142.0.3595.53",
			`HKLM 32-bit Clients\pv in %ProgramFiles(x86)%`},
		{`C:\Program Files\Microsoft\EdgeWebView\Application\142.0.3595.53`, "142.0.3595.53",
			`HKLM 32-bit Clients\pv in %ProgramFiles%`},
		{`C:\Users\Zoë\AppData\Local\Microsoft\EdgeWebView\Application\141.0.1.2`, "141.0.1.2",
			`HKCU Clients\location+pv`},
		{`C:\Users\Zoë\AppData\Local\Microsoft\EdgeWebView\Application\141.0.1.2`, "141.0.1.2",
			`HKCU Clients\pv in %LOCALAPPDATA%`},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("runtimeCandidates =\n%q\nwant\n%q", got, want)
	}
}

func TestRuntimeCandidatesSkipWhatIsNotInstalled(t *testing.T) {
	env := environment(map[string]string{"ProgramFiles(x86)": `C:\Program Files (x86)`})
	readings := []runtimeReading{
		{View: "old", Folder: `C:\x\Application\85.0.564.0`, Version: "85.0.564.0"},
		{View: "zero", Version: "0.0.0.0"},
		{View: "odd folder", Folder: `C:\x\Application\current`},
		{View: "empty"},
	}
	if got := runtimeCandidates(readings, env); len(got) != 0 {
		t.Errorf("runtimeCandidates = %q, want none", got)
	}

	if got := runtimeCandidates([]runtimeReading{{View: "pv only", Version: "142.0.1.1"}}, environment(nil)); len(got) != 0 {
		t.Errorf("a pv with no folder to look in gave %q", got)
	}
}

func TestPickRuntimeTakesTheFirstWithItsDLL(t *testing.T) {
	candidates := []runtimeCandidate{
		{Folder: `C:\gone\142.0.0.1`, Version: "142.0.0.1"},
		{Folder: `C:\here\141.0.0.1`, Version: "141.0.0.1"},
		{Folder: `C:\also\140.0.0.1`, Version: "140.0.0.1"},
	}
	present := map[string]bool{
		`C:\here\141.0.0.1\EBWebView\x64\EmbeddedBrowserWebView.dll`: true,
		`C:\also\140.0.0.1\EBWebView\x64\EmbeddedBrowserWebView.dll`: true,
	}

	got, ok := pickRuntime(candidates, func(p string) bool { return present[p] })
	if !ok || got != candidates[1] {
		t.Errorf("pickRuntime = %+v, %v; want %+v", got, ok, candidates[1])
	}

	if _, ok := pickRuntime(candidates, func(string) bool { return false }); ok {
		t.Error("pickRuntime found a runtime with no DLL")
	}
}
