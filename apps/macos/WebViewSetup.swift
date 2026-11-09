// The web view both macOS hosts of the player use: the game app (docs/plan.md
// Phase 43 item 7) and the scenario suite's WebKit driver (driver/main.swift).
// Both compile this one file, so what the suite tests is what readers get.
// Only what both hosts must agree on lives here; the app's window, menus and
// panels and the driver's test hooks stay in their own sources.
//
// Builds for macOS 12 and later (the app's minimum).

import WebKit

enum KineticWebView {
    /// Where the page's storage (IndexedDB, localStorage) lives.
    enum Storage {
        /// On disk, kept across launches: the game app.
        case persistent
        /// In memory, gone when the process ends: one driver process is one
        /// fresh profile, as one Chrome launch is in the suite.
        case nonPersistent
    }

    /// The configuration the player runs under.
    static func configuration(storage: Storage) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        // Videos and their sound start without a click, as the player
        // expects of a page it opens itself.
        config.mediaTypesRequiringUserActionForPlayback = []
        // The player reads its own files over file://, as it does in Chrome
        // and Safari when index.html is double-clicked.
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        switch storage {
        case .persistent: config.websiteDataStore = .default()
        case .nonPersistent: config.websiteDataStore = .nonPersistent()
        }
        return config
    }

    /// A web view with that configuration (plus whatever a host adds to
    /// `configuration` before calling this).
    static func make(frame: NSRect, configuration: WKWebViewConfiguration) -> WKWebView {
        let webView = WKWebView(frame: frame, configuration: configuration)
        // Safari's Web Inspector can attach (Develop menu), for debugging.
        if #available(macOS 13.3, *) { webView.isInspectable = true }
        return webView
    }

    /// Opens a page of the game folder, which the page may read whole.
    static func load(_ webView: WKWebView, page: URL) {
        webView.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
    }

    /// Export on the Esc screen is a download (an `<a download>` click).
    static func policy(for action: WKNavigationAction) -> WKNavigationActionPolicy {
        action.shouldPerformDownload ? .download : .allow
    }

    /// A response the view cannot show is saved rather than dropped.
    static func policy(for response: WKNavigationResponse) -> WKNavigationResponsePolicy {
        response.canShowMIMEType ? .allow : .download
    }
}
