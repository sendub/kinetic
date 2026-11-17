package main

// The exe's own words in the reader's language (docs/plan.md Phase 56 item
// 7): the error box it shows before the page loads, in the language
// Windows names first among the user's UI languages that the player's
// catalogue has (the player's own matching rule, bestLanguageMatch), and
// the window title the page asks for with its language message
// (apps/README.md, "The page-to-host protocol"). The words come from
// apps/host-words.json, which `npm run i18n` writes from the player's
// catalogue and the host build (kinetic_extract/app_hosts.py) embeds
// (hostwords_embedded.go, never committed). Platform-neutral (hostwords_test.go).

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	utf16le "unicode/utf16"
)

// embeddedHostWords is apps/host-words.json as the build embeds it; nil in
// a build without it (go test), where the English below serves.
var embeddedHostWords []byte

// englishHostWords is the English of every message the exe draws itself,
// for a build without the table; hostwords_test.go checks it against
// apps/host-words.json.
var englishHostWords = map[string]string{
	"host.windows.missing": "{title} cannot find {file} next to this program.\n\n" +
		"Keep the program inside its game folder, or open the folder's {file} instead.",
}

// sourceLanguage is the catalogue's source and the last resort.
const sourceLanguage = "en"

// hostWords is the table: language tag -> message key -> text.
type hostWords map[string]map[string]string

// parseHostWords reads apps/host-words.json; nil when it is missing or
// unreadable.
func parseHostWords(data []byte) hostWords {
	var file struct {
		Languages hostWords `json:"languages"`
	}

	if len(data) == 0 || json.Unmarshal(data, &file) != nil {
		return nil
	}

	return file.Languages
}

// languages is the table's languages, English first, the rest in tag
// order, as the player lists its catalogue.
func (w hostWords) languages() []string {
	tags := []string{sourceLanguage}

	for tag := range w {
		if tag != sourceLanguage {
			tags = append(tags, tag)
		}
	}

	sort.Strings(tags[1:])

	return tags
}

// text is message key in language lang with its {name} placeholders
// filled from params: the language's text, else English's, else the
// built-in English, else the key.
func (w hostWords) text(lang, key string, params map[string]string) string {
	message := w[lang][key]
	if message == "" {
		message = w[sourceLanguage][key]
	}

	if message == "" {
		message = englishHostWords[key]
	}

	if message == "" {
		message = key
	}

	return fillPlaceholders(message, params)
}

// placeholder is a {name} in a message.
var placeholder = regexp.MustCompile(`\{([A-Za-z0-9_]+)\}`)

// fillPlaceholders puts params into message's {name}s; an unknown one is
// left as written.
func fillPlaceholders(message string, params map[string]string) string {
	return placeholder.ReplaceAllStringFunc(message, func(whole string) string {
		if value, ok := params[whole[1:len(whole)-1]]; ok {
			return value
		}

		return whole
	})
}

// hostLanguage is the table's language for the user's UI languages
// (requested, most wanted first), else English.
func hostLanguage(requested []string, w hostWords) string {
	if found := bestLanguageMatch(requested, w.languages()); found != "" {
		return found
	}

	return sourceLanguage
}

// splitMultiString reads GetUserPreferredUILanguages' answer: UTF-16
// strings, each ended by a NUL, the list ended by another.
func splitMultiString(buffer []uint16) []string {
	var list []string

	start := 0

	for i, unit := range buffer {
		if unit != 0 {
			continue
		}

		if i == start {
			break
		}

		list = append(list, string(utf16le.Decode(buffer[start:i])))
		start = i + 1
	}

	return list
}

// --- the player's matching rule (player/src/i18n/languages.ts) --------------

// likelyTag is a tag's language, script and region with the likely ones
// filled in, and the region the tag itself named.
type likelyTag struct {
	language, script, region, ownRegion string
}

// likelyScripts and likelyRegions are CLDR's likely subtags
// (Intl.Locale.maximize) for the catalogue's languages, which is all the
// matching needs: a language the catalogue lacks matches nothing anyway.
// Chinese takes its script from its region (hantRegions).
var (
	likelyScripts = map[string]string{
		"ar": "Arab", "bg": "Cyrl", "ca": "Latn", "cs": "Latn", "da": "Latn", "de": "Latn", "el": "Grek",
		"en": "Latn", "es": "Latn", "fa": "Arab", "fi": "Latn", "fr": "Latn", "he": "Hebr", "hi": "Deva",
		"hr": "Latn", "hu": "Latn", "id": "Latn", "it": "Latn", "ja": "Jpan", "ko": "Kore", "ms": "Latn",
		"nb": "Latn", "nl": "Latn", "pl": "Latn", "pt": "Latn", "ro": "Latn", "ru": "Cyrl", "sk": "Latn",
		"sv": "Latn", "sw": "Latn", "th": "Thai", "tr": "Latn", "uk": "Cyrl", "ur": "Arab", "vi": "Latn",
	}
	likelyRegions = map[string]string{
		"ar": "EG", "bg": "BG", "ca": "ES", "cs": "CZ", "da": "DK", "de": "DE", "el": "GR", "en": "US",
		"es": "ES", "fa": "IR", "fi": "FI", "fr": "FR", "he": "IL", "hi": "IN", "hr": "HR", "hu": "HU",
		"id": "ID", "it": "IT", "ja": "JP", "ko": "KR", "ms": "MY", "nb": "NO", "nl": "NL", "pl": "PL",
		"pt": "BR", "ro": "RO", "ru": "RU", "sk": "SK", "sv": "SE", "sw": "TZ", "th": "TH", "tr": "TR",
		"uk": "UA", "ur": "PK", "vi": "VN", "zh-Hans": "CN", "zh-Hant": "TW",
	}
	hantRegions = map[string]bool{"TW": true, "HK": true, "MO": true}
	// languageAliases are the deprecated codes Intl.Locale replaces.
	languageAliases = map[string]string{"iw": "he", "in": "id"}
	// regionGroups: Spanish of Latin America and the Caribbean, es-419,
	// takes these regions (CLDR's parentLocales).
	regionGroups = map[string]map[string]bool{"419": setOf("AR", "BO", "BR", "BZ", "CL", "CO", "CR", "CU",
		"DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE", "PR", "PY", "SV", "US", "UY", "VE")}
)

func setOf(items ...string) map[string]bool {
	set := map[string]bool{}
	for _, item := range items {
		set[item] = true
	}

	return set
}

var (
	languageSubtag = regexp.MustCompile(`^[a-z]{2,3}$`)
	scriptSubtag   = regexp.MustCompile(`^[A-Za-z]{4}$`)
	regionSubtag   = regexp.MustCompile(`^(?:[A-Za-z]{2}|[0-9]{3})$`)
)

// likely is tag with its likely script and region; false for a tag with no
// language subtag.
func likely(tag string) (likelyTag, bool) {
	parts := strings.FieldsFunc(tag, func(r rune) bool { return r == '-' || r == '_' })
	if len(parts) == 0 {
		return likelyTag{}, false
	}

	language := strings.ToLower(parts[0])
	if !languageSubtag.MatchString(language) {
		return likelyTag{}, false
	}

	if alias, ok := languageAliases[language]; ok {
		language = alias
	}

	t := likelyTag{language: language}

	for _, part := range parts[1:] {
		switch {
		case t.script == "" && scriptSubtag.MatchString(part):
			t.script = strings.ToUpper(part[:1]) + strings.ToLower(part[1:])
		case t.ownRegion == "" && regionSubtag.MatchString(part):
			t.ownRegion = strings.ToUpper(part)
		}
	}

	t.region = t.ownRegion

	if t.script == "" {
		t.script = likelyScripts[language]

		if language == "zh" {
			t.script = "Hans"
			if hantRegions[t.region] {
				t.script = "Hant"
			}
		}
	}

	if t.region == "" {
		t.region = likelyRegions[language+"-"+t.script]
		if t.region == "" {
			t.region = likelyRegions[language]
		}
	}

	return t, true
}

// matchOne is the best of available for one requested tag, or "": the
// same tag (case aside); else the same language and script and the same
// likely region; else a region group holding the requested region
// (es-MX takes es-419); else the same language and script, a tag naming
// no region first. A different script never matches.
func matchOne(requested string, available []string) string {
	for _, tag := range available {
		if strings.EqualFold(tag, requested) {
			return tag
		}
	}

	want, ok := likely(requested)
	if !ok {
		return ""
	}

	type candidate struct {
		tag  string
		full likelyTag
	}

	var candidates []candidate

	for _, tag := range available {
		if full, ok := likely(tag); ok && full.language == want.language && full.script == want.script {
			candidates = append(candidates, candidate{tag, full})
		}
	}

	if len(candidates) == 0 {
		return ""
	}

	for _, c := range candidates {
		if c.full.region == want.region {
			return c.tag
		}
	}

	for _, c := range candidates {
		if regionGroups[c.full.ownRegion][want.region] {
			return c.tag
		}
	}

	for _, c := range candidates {
		if c.full.ownRegion == "" {
			return c.tag
		}
	}

	return candidates[0].tag
}

// bestLanguageMatch is the best of available for the requested tags in
// their order: the first with any match wins; "" when none matches.
func bestLanguageMatch(requested, available []string) string {
	for _, tag := range requested {
		if tag == "" {
			continue
		}

		if found := matchOne(tag, available); found != "" {
			return found
		}
	}

	return ""
}
