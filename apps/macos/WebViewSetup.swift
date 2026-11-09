// The web view both macOS hosts of the player use: the game app (docs/plan.md
// Phase 43 item 7) and the scenario suite's WebKit driver (driver/main.swift).
// Both compile this one file, so what the suite tests is what readers get.
// Only what both hosts must agree on lives here (the web view's setup, the
// page-to-host bridge, and what the window does with a key the page left
// unhandled); the app's window frame, menus and panels and the driver's
// test hooks stay in their own sources.
//
// Builds for macOS 12 and later (the app's minimum).

import WebKit

/// The window the game's web view sits in, in both hosts: it keeps every
/// key for the game. A keydown the page does not take (no
/// `preventDefault`) comes back from WKWebView through `NSApp.sendEvent`
/// and up the responder chain to the window. NSWindow's own `keyDown`
/// would run AppKit's keyboard interface on it (Tab moves the key view; in
/// fullscreen, Esc can leave it) and then beep; this window drops it
/// instead. Key equivalents are not keyDowns: NSApp offers them to the key
/// window's views (the page first, through WKWebView) and then to the main
/// menu before any keyDown reaches a window. The page leaves every key held
/// with ⌘ (player/src/render/keys.ts), so the menus' shortcuts (⌘Q, ⌘R,
/// ⌃⌘F) still work; one the page took would never reach the menu.
class KineticWindow: NSWindow {
    /// Called with each key the window drops; the driver reports them.
    var keyDropped: ((NSEvent) -> Void)?

    override func keyDown(with event: NSEvent) {
        keyDropped?(event)
    }

    // An Esc the page did not take also arrives as cancelOperation (WebKit
    // passes the key's command up the responder chain), as does ⌘.: it must
    // not leave fullscreen either.
    override func cancelOperation(_ sender: Any?) {}
}

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

/// The macOS side of the page-to-host protocol (docs/plan.md Phase 43 item
/// 9; apps/README.md). A user script at document start gives the page
/// `window.kineticHost = { kind, display, send(message) }`; `send` posts to
/// the `kineticHost` message handler, which passes `{ type: "quit" }` and
/// `{ type: "display", mode }` to the host's closures. `setDisplay` tells
/// the page a new mode (the page's own request carried out, or the reader's
/// green button, menu or shortcut): the live object changes and the page
/// gets a `kinetic-host` event. The user script is swapped on every change,
/// so a reload starts with the mode in force.
///
/// Both hosts install this: the game app with closures that quit and switch
/// its window, the scenario suite's driver with ones that record.
final class KineticHostBridge: NSObject, WKScriptMessageHandler {
    static let handlerName = "kineticHost"
    /// Where the user script keeps its setter (not enumerable).
    static let setterName = "__kineticHostSetDisplay"

    enum Display: String {
        case fullscreen
        case window
    }

    let kind: String
    private(set) var display: Display
    private let onQuit: () -> Void
    private let onDisplay: (Display) -> Void
    private weak var controller: WKUserContentController?
    private var script: WKUserScript?

    init(kind: String, display: Display, onQuit: @escaping () -> Void,
         onDisplay: @escaping (Display) -> Void)
    {
        self.kind = kind
        self.display = display
        self.onQuit = onQuit
        self.onDisplay = onDisplay
    }

    /// Adds the user script and the message handler. The controller keeps
    /// the bridge (the handler), so the closures must not hold the web view
    /// strongly.
    func install(on controller: WKUserContentController) {
        self.controller = controller
        controller.add(self, name: Self.handlerName)
        let fresh = makeScript()
        controller.addUserScript(fresh)
        script = fresh
    }

    /// Records `display` as the mode now and tells the page, if it differs.
    /// `done` runs once the page has it.
    func setDisplay(_ next: Display, in webView: WKWebView?, done: (() -> Void)? = nil) {
        guard next != display else {
            done?()
            return
        }
        display = next
        swapScript()
        guard let webView else {
            done?()
            return
        }
        let call = "window.\(Self.setterName) && window.\(Self.setterName)(\(Self.literal(next.rawValue)));"
        webView.evaluateJavaScript(call) { _, _ in done?() }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the game's own page speaks for it (the user script is
        // main-frame only, but the handler is reachable from any frame).
        guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any] else { return }
        switch body["type"] as? String {
        case "quit":
            onQuit()
        case "display":
            if let mode = (body["mode"] as? String).flatMap(Display.init(rawValue:)) { onDisplay(mode) }
        default:
            break
        }
    }

    /// The user script for the mode now.
    private func makeScript() -> WKUserScript {
        let source = """
            (() => {
              const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.\(Self.handlerName);
              if (!handler || window.kineticHost) return;
              let display = \(Self.literal(display.rawValue));
              const host = Object.freeze({
                kind: \(Self.literal(kind)),
                get display() { return display; },
                send(message) { handler.postMessage(message); },
              });
              Object.defineProperty(window, "kineticHost", { value: host });
              Object.defineProperty(window, "\(Self.setterName)", {
                value(mode) {
                  if (mode === display) return;
                  display = mode;
                  window.dispatchEvent(new Event("kinetic-host"));
                },
              });
              window.dispatchEvent(new Event("kinetic-host"));
            })();
            """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }

    /// Replaces the user script with one for the mode now, keeping every
    /// other script the host added in its place.
    private func swapScript() {
        guard let controller, let old = script else { return }
        let fresh = makeScript()
        let scripts = controller.userScripts.map { $0 === old ? fresh : $0 }
        controller.removeAllUserScripts()
        scripts.forEach(controller.addUserScript)
        script = fresh
    }

    /// `text` as a JavaScript string literal.
    private static func literal(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}
