// The game app's own words in the reader's language (docs/plan.md Phase 56
// item 7), shared by both macOS hosts: the game app (app/main.swift) and
// the scenario suite's WebKit driver (driver/main.swift), so the suite
// tests what readers get. The words come from apps/host-words.json, which
// `npm run i18n` writes from the player's catalogue; the app's host build
// (kinetic_extract/app_hosts.py) and player/scripts/webkit/build.mjs compile
// it in as a generated KineticHostWordsEmbedded.swift (never committed).
//
// Before the page loads (the alert when the app cannot find its game), the
// language is the first of the system's preferred languages the catalogue
// has, by the player's own matching rule (player/src/i18n/languages.ts,
// bestLanguageMatch), else English. Once the page runs it says its UI
// language in a `language` message (HostLanguage) and the menus and the
// window title follow it.
//
// Builds for macOS 12 and later (the app's minimum).

import Foundation

/// The table: language tag -> message key -> text.
struct HostWords {
    static let sourceLanguage = "en"

    let table: [String: [String: String]]

    /// The table compiled into this binary.
    static let embedded = HostWords(json: Data(base64Encoded: KineticHostWordsEmbedded.base64) ?? Data())

    /// apps/host-words.json read; an unreadable one is an empty table, so
    /// every lookup reads its key.
    init(json: Data) {
        let object = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any]
        var table: [String: [String: String]] = [:]
        for (tag, words) in object?["languages"] as? [String: Any] ?? [:] {
            if let words = words as? [String: String] { table[tag] = words }
        }
        self.table = table
    }

    /// The table's languages, English first, the rest in tag order, as the
    /// player lists its catalogue.
    var languages: [String] {
        [Self.sourceLanguage] + table.keys.filter { $0 != Self.sourceLanguage }.sorted()
    }

    /// The language for `requested` (most wanted first): the first with a
    /// match in the table, else English.
    func language(for requested: [String]) -> String {
        LanguageMatch.best(requested, languages) ?? Self.sourceLanguage
    }

    /// Message `key` in `language` with its `{name}` placeholders filled:
    /// the language's text, else English's, else the key.
    func text(_ key: String, in language: String, _ params: [String: String] = [:]) -> String {
        let message = table[language]?[key] ?? table[Self.sourceLanguage]?[key] ?? key
        return Self.fill(message, params)
    }

    /// `message` with each `{name}` that `params` has replaced, in one pass
    /// (a value's own braces stay as they are); others are left as written.
    static func fill(_ message: String, _ params: [String: String]) -> String {
        var out = ""
        var rest = Substring(message)
        while let open = rest.firstIndex(of: "{") {
            out += rest[..<open]
            let after = rest[rest.index(after: open)...]
            if let close = after.firstIndex(of: "}"), let value = params[String(after[..<close])] {
                out += value
                rest = after[after.index(after: close)...]
            } else {
                out += "{"
                rest = after
            }
        }
        return out + rest
    }
}

/// The page's `{ type: "language", ui, dir, title? }` message: its UI
/// language, that language's direction, and the game's title as shown.
struct HostLanguage: Equatable {
    let ui: String
    let dir: String
    let title: String?

    /// The message read; nil without a `ui`. A blank title is none.
    init?(message: [String: Any]) {
        guard message["type"] as? String == "language", let ui = message["ui"] as? String, !ui.isEmpty else {
            return nil
        }
        self.ui = ui
        dir = message["dir"] as? String == "rtl" ? "rtl" : "ltr"
        let title = (message["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = title?.isEmpty == false ? title : nil
    }

    /// The title the window and the menus take: the page's, else `game`.
    func shownTitle(or game: String) -> String { title ?? game }
}

/// The words of the game app's menus for a language and a title.
struct HostMenuTitles: Equatable {
    let hide: String
    let quit: String
    let view: String
    let reload: String
    let fullScreen: String

    init(_ words: HostWords, language: String, title: String) {
        let named = ["title": title]
        hide = words.text("host.menu.hide", in: language, named)
        quit = words.text("host.menu.quit", in: language, named)
        view = words.text("host.menu.view", in: language)
        reload = words.text("host.menu.reload", in: language)
        fullScreen = words.text("host.menu.fullScreen", in: language)
    }

    var dictionary: [String: String] {
        ["hide": hide, "quit": quit, "view": view, "reload": reload, "fullScreen": fullScreen]
    }
}

/// The alert the game app shows when there is no index.html beside it.
struct HostMissingGameAlert: Equatable {
    let title: String
    let text: String
    let quit: String

    init(_ words: HostWords, language: String, title game: String, file: String = "index.html") {
        title = words.text("host.mac.missing.title", in: language, ["title": game])
        text = words.text("host.mac.missing.text", in: language, ["file": file])
        quit = words.text("host.mac.missing.quit", in: language)
    }

    var dictionary: [String: String] { ["title": title, "text": text, "quit": quit] }
}

/// The player's matching rule (player/src/i18n/languages.ts), with CLDR's
/// likely subtags (Intl.Locale.maximize) for the catalogue's languages,
/// which is all it needs: a language the catalogue lacks matches nothing
/// anyway. apps/windows/hostwords.go holds the same rule;
/// apps/host-language-cases.json holds the cases all three must agree on.
enum LanguageMatch {
    static let likelyScripts: [String: String] = [
        "ar": "Arab", "bg": "Cyrl", "ca": "Latn", "cs": "Latn", "da": "Latn", "de": "Latn", "el": "Grek",
        "en": "Latn", "es": "Latn", "fa": "Arab", "fi": "Latn", "fr": "Latn", "he": "Hebr", "hi": "Deva",
        "hr": "Latn", "hu": "Latn", "id": "Latn", "it": "Latn", "ja": "Jpan", "ko": "Kore", "ms": "Latn",
        "nb": "Latn", "nl": "Latn", "pl": "Latn", "pt": "Latn", "ro": "Latn", "ru": "Cyrl", "sk": "Latn",
        "sv": "Latn", "sw": "Latn", "th": "Thai", "tr": "Latn", "uk": "Cyrl", "ur": "Arab", "vi": "Latn",
    ]
    static let likelyRegions: [String: String] = [
        "ar": "EG", "bg": "BG", "ca": "ES", "cs": "CZ", "da": "DK", "de": "DE", "el": "GR", "en": "US",
        "es": "ES", "fa": "IR", "fi": "FI", "fr": "FR", "he": "IL", "hi": "IN", "hr": "HR", "hu": "HU",
        "id": "ID", "it": "IT", "ja": "JP", "ko": "KR", "ms": "MY", "nb": "NO", "nl": "NL", "pl": "PL",
        "pt": "BR", "ro": "RO", "ru": "RU", "sk": "SK", "sv": "SE", "sw": "TZ", "th": "TH", "tr": "TR",
        "uk": "UA", "ur": "PK", "vi": "VN", "zh-Hans": "CN", "zh-Hant": "TW",
    ]
    /// Chinese of these regions is written in Traditional characters.
    static let hantRegions: Set<String> = ["TW", "HK", "MO"]
    /// The deprecated codes Intl.Locale replaces.
    static let languageAliases = ["iw": "he", "in": "id"]
    /// Spanish of Latin America and the Caribbean, es-419, takes these
    /// regions (CLDR's parentLocales).
    static let regionGroups: [String: Set<String>] = [
        "419": [
            "AR", "BO", "BR", "BZ", "CL", "CO", "CR", "CU", "DO", "EC", "GT", "HN", "MX", "NI", "PA", "PE",
            "PR", "PY", "SV", "US", "UY", "VE",
        ]
    ]

    struct Likely: Equatable {
        let language: String
        let script: String
        let region: String
        /// The region the tag itself named ("" for none).
        let ownRegion: String
    }

    static func isLetters(_ text: Substring, _ count: Int) -> Bool {
        text.count == count && text.allSatisfy { $0.isASCII && $0.isLetter }
    }

    /// `tag` with its likely script and region; nil with no language subtag.
    static func likely(_ tag: String) -> Likely? {
        let parts = tag.split(whereSeparator: { $0 == "-" || $0 == "_" })
        guard let first = parts.first else { return nil }
        var language = first.lowercased()
        guard (2...3).contains(language.count), language.allSatisfy({ $0.isASCII && $0.isLetter }) else {
            return nil
        }
        language = languageAliases[language] ?? language
        var script = "", ownRegion = ""
        for part in parts.dropFirst() {
            if script.isEmpty, isLetters(part, 4) {
                script = part.prefix(1).uppercased() + part.dropFirst().lowercased()
            } else if ownRegion.isEmpty,
                isLetters(part, 2) || (part.count == 3 && part.allSatisfy { $0.isASCII && $0.isNumber })
            {
                ownRegion = part.uppercased()
            }
        }
        if script.isEmpty {
            script = language == "zh" ? (hantRegions.contains(ownRegion) ? "Hant" : "Hans") : likelyScripts[language] ?? ""
        }
        let region = ownRegion.isEmpty
            ? likelyRegions["\(language)-\(script)"] ?? likelyRegions[language] ?? "" : ownRegion
        return Likely(language: language, script: script, region: region, ownRegion: ownRegion)
    }

    /// The best of `available` for one requested tag: the same tag (case
    /// aside); else the same language and script and the same likely
    /// region; else a region group holding the requested region; else the
    /// same language and script, a tag naming no region first. A different
    /// script never matches.
    static func matchOne(_ requested: String, _ available: [String]) -> String? {
        if let exact = available.first(where: { $0.lowercased() == requested.lowercased() }) { return exact }
        guard let want = likely(requested) else { return nil }
        let candidates = available.compactMap { tag -> (tag: String, full: Likely)? in
            guard let full = likely(tag), full.language == want.language, full.script == want.script else {
                return nil
            }
            return (tag, full)
        }
        if let same = candidates.first(where: { $0.full.region == want.region }) { return same.tag }
        if let grouped = candidates.first(where: { regionGroups[$0.full.ownRegion]?.contains(want.region) == true }) {
            return grouped.tag
        }
        return (candidates.first(where: { $0.full.ownRegion.isEmpty }) ?? candidates.first)?.tag
    }

    /// The best of `available` for the requested tags in their order: the
    /// first with any match wins; nil when none matches.
    static func best(_ requested: [String], _ available: [String]) -> String? {
        for tag in requested where !tag.isEmpty {
            if let found = matchOne(tag, available) { return found }
        }
        return nil
    }
}
