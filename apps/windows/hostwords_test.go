package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	utf16le "unicode/utf16"
)

// The table npm run i18n writes (apps/host-words.json) and the matching
// cases the player, this program and the Mac app share
// (apps/host-language-cases.json).
const (
	hostWordsFile = "../host-words.json"
	casesFile     = "../host-language-cases.json"
)

func readHostWords(t *testing.T) hostWords {
	t.Helper()

	data, err := os.ReadFile(hostWordsFile)
	if err != nil {
		t.Fatal(err)
	}

	words := parseHostWords(data)
	if words == nil {
		t.Fatalf("%s is not a table", hostWordsFile)
	}

	return words
}

func TestHostLanguageMatchesAsThePlayerDoes(t *testing.T) {
	data, err := os.ReadFile(casesFile)
	if err != nil {
		t.Fatal(err)
	}

	var file struct {
		Catalogue []string `json:"catalogue"`
		Cases     []struct {
			Requested []string `json:"requested"`
			Expect    *string  `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}

	if got := readHostWords(t).languages(); strings.Join(got, " ") != strings.Join(file.Catalogue, " ") {
		t.Errorf("the table's languages %v are not the catalogue's %v", got, file.Catalogue)
	}

	for _, c := range file.Cases {
		want := ""
		if c.Expect != nil {
			want = *c.Expect
		}

		if got := bestLanguageMatch(c.Requested, file.Catalogue); got != want {
			t.Errorf("bestLanguageMatch(%q) = %q, want %q", c.Requested, got, want)
		}
	}

	if len(file.Cases) < 30 {
		t.Errorf("only %d cases", len(file.Cases))
	}
}

func TestHostLanguageFallsBackToEnglish(t *testing.T) {
	words := readHostWords(t)
	cases := map[string][]string{
		"de":      {"de-CH", "en-US"},
		"zh-Hant": {"zh-HK"},
		"es-419":  {"es-MX"},
		"en":      {"tlh", "eo"},
	}

	for want, requested := range cases {
		if got := hostLanguage(requested, words); got != want {
			t.Errorf("hostLanguage(%q) = %q, want %q", requested, got, want)
		}
	}

	if got := hostLanguage(nil, words); got != "en" {
		t.Errorf("no languages: %q", got)
	}

	if got := hostLanguage([]string{"de"}, nil); got != "en" {
		t.Errorf("no table: %q", got)
	}
}

func TestHostWordsLookup(t *testing.T) {
	words := readHostWords(t)
	params := map[string]string{"title": "Rainy Day", "file": pageName}

	en := words.text("en", "host.windows.missing", params)
	if en != "Rainy Day cannot find index.html next to this program.\n\n"+
		"Keep the program inside its game folder, or open the folder's index.html instead." {
		t.Errorf("English: %q", en)
	}

	de := words.text("de", "host.windows.missing", params)
	if !strings.HasPrefix(de, "Rainy Day findet index.html nicht") || strings.Contains(de, "{") {
		t.Errorf("German: %q", de)
	}

	ar := words.text("ar", "host.windows.missing", params)
	if !strings.Contains(ar, "Rainy Day") || !strings.Contains(ar, "index.html") || ar == en {
		t.Errorf("Arabic: %q", ar)
	}

	// A language the table lacks, or a key a language lacks, reads English;
	// a key nobody has reads as itself.
	if got := words.text("tlh", "host.windows.missing", params); got != en {
		t.Errorf("unknown language: %q", got)
	}

	partial := hostWords{"en": words["en"], "de": {}}
	if got := partial.text("de", "host.windows.missing", params); got != en {
		t.Errorf("a key German lacks: %q", got)
	}

	if got := words.text("de", "host.nothing", nil); got != "host.nothing" {
		t.Errorf("an unknown key: %q", got)
	}

	// Without a table (go test, a plain go build) the built-in English serves.
	var none hostWords
	if got := none.text("de", "host.windows.missing", params); got != en {
		t.Errorf("no table: %q", got)
	}
}

func TestBuiltInEnglishIsTheCatalogues(t *testing.T) {
	words := readHostWords(t)
	for key, text := range englishHostWords {
		if words["en"][key] != text {
			t.Errorf("%s: built in %q, the catalogue says %q", key, text, words["en"][key])
		}
	}

	for tag, messages := range words {
		if messages["host.windows.missing"] == "" {
			t.Errorf("%s has no host.windows.missing", tag)
		}
	}
}

func TestFillPlaceholders(t *testing.T) {
	got := fillPlaceholders("{title} and {file} and {title} and {other}", map[string]string{
		"title": "A {file}", "file": "b",
	})
	if got != "A {file} and b and A {file} and {other}" {
		t.Errorf("fillPlaceholders = %q", got)
	}
}

func TestParseHostWordsRefusesJunk(t *testing.T) {
	for _, data := range []string{"", "{", "[]", `{"languages":7}`} {
		if words := parseHostWords([]byte(data)); words != nil {
			t.Errorf("parseHostWords(%q) = %v", data, words)
		}
	}
}

func TestSplitMultiString(t *testing.T) {
	buffer := append(utf16le.Encode([]rune("de-CH\x00en-US\x00zh-Hant-TW\x00\x00")), 0, 0)
	got := splitMultiString(buffer)

	if strings.Join(got, ",") != "de-CH,en-US,zh-Hant-TW" {
		t.Errorf("splitMultiString = %q", got)
	}

	if got := splitMultiString([]uint16{0, 0}); len(got) != 0 {
		t.Errorf("empty list = %q", got)
	}

	if got := splitMultiString(nil); len(got) != 0 {
		t.Errorf("nil = %q", got)
	}
}
