// The macOS game app (docs/plan.md Phase 43 item 7; CREATE.md, "Building
// the apps"). tools/build_apps.py compiles this file with
// ../WebViewSetup.swift into `<title>.app` inside a game folder. The app
// shows the folder it sits in through the system WebKit (the engine Safari
// uses, on every Mac): its own name and Dock icon, fullscreen from launch,
// Esc and reload wholly the game's. The bundle holds only this binary, its
// icon and Info.plist; the media stays in the folder beside it.

import AppKit
import WebKit

/// The game's name, which build_apps.py writes into Info.plist from the
/// manifest title, for the menus and the window's first title.
let gameTitle =
    Bundle.main.object(forInfoDictionaryKey: "KineticTitle") as? String
    ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
    ?? "Kinetic"

/// The game's one window. Keys the page leaves unhandled travel up the
/// responder chain to the window, whose default is a system beep; a reader
/// presses space hundreds of times, so the window swallows them instead.
final class GameWindow: NSWindow {
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)) { return }
        super.noResponder(for: eventSelector)
    }

    // Esc that the page did not consume arrives here as cancelOperation:
    // it must neither beep nor leave fullscreen.
    override func cancelOperation(_ sender: Any?) {}
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate,
    WKUIDelegate, WKDownloadDelegate
{
    var window: GameWindow!
    var webView: WKWebView!
    var titleObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let page = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: page.path) else {
            explainMissingGame()
            NSApp.terminate(nil)
            return
        }

        // On disk under this app's bundle id, so progress survives a quit.
        // A page-to-app message handler (the Esc screen's Exit and
        // Fullscreen / Window, docs/plan.md Phase 43 item 9) is added to
        // `config.userContentController` here.
        let config = KineticWebView.configuration(storage: .persistent)
        let frame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1280, height: 800)
        webView = KineticWebView.make(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = GameWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = gameTitle
        window.backgroundColor = .black
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        // Fullscreen as a window, not the page's element fullscreen, so Esc
        // and reload keep it.
        window.toggleFullScreen(nil)
        titleObservation = webView.observe(\.title) { [weak self] view, _ in
            if let title = view.title, !title.isEmpty { self?.window.title = title }
        }
        KineticWebView.load(webView, page: page)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The app plays the index.html beside it. Moved out of its folder, or
    /// opened from a quarantined download (which macOS runs from a hidden
    /// copy elsewhere, App Translocation), it finds none and says why.
    private func explainMissingGame() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "\(gameTitle) cannot find its game."
        alert.informativeText =
            "This app plays the index.html file in the folder it sits in, and there is none next to it. "
            + "Keep the app inside its game folder. If the game folder was downloaded, "
            + "open index.html in it instead."
        alert.addButton(withTitle: "Quit")
        alert.runModal()
    }

    // Closing the window ends the game, so the next double-click starts it
    // fullscreen again; a double-click while it runs just brings it forward.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    // A crashed page would leave the window black; the player resumes where
    // the reader was.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Export (a download) and Import (a file panel) on the Esc screen

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        decisionHandler(KineticWebView.policy(for: navigationAction))
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(KineticWebView.policy(for: navigationResponse))
    }

    func webView(
        _ webView: WKWebView, navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView, navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    /// Saves into ~/Downloads, as a browser does, never over a file there:
    /// `<name> 2.json`, `<name> 3.json` and so on.
    func download(
        _ download: WKDownload, decideDestinationUsing response: URLResponse,
        suggestedFilename: String, completionHandler: @escaping (URL?) -> Void
    ) {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var target = downloads.appendingPathComponent(suggestedFilename)
        let stem = target.deletingPathExtension().lastPathComponent
        let ext = target.pathExtension
        var n = 1
        while FileManager.default.fileExists(atPath: target.path) {
            n += 1
            target = downloads.appendingPathComponent("\(stem) \(n)")
            if !ext.isEmpty { target.appendPathExtension(ext) }
        }
        completionHandler(target)
    }

    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    // MARK: menus

    @objc func reload(_ sender: Any?) { webView.reload() }

    private func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "Hide \(gameTitle)", action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "Quit \(gameTitle)", action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q")
        appItem.submenu = appMenu

        let viewItem = NSMenuItem()
        main.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let reloadItem = viewMenu.addItem(
            withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        reloadItem.target = self
        let fullscreen = viewMenu.addItem(
            withTitle: "Toggle Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f")
        fullscreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
