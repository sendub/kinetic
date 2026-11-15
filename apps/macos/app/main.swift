// The macOS game app (docs/plan.md Phase 43 items 7 and 9; CREATE.md,
// "Building the apps"). tools/build_apps.py compiles this file with
// ../WebViewSetup.swift into `<title>.app` inside a game folder. The app
// shows the folder it sits in through the system WebKit (the engine Safari
// uses, on every Mac): its own name and Dock icon, Esc and reload wholly
// the game's. Every key but the menus' shortcuts is the game's: one the
// page leaves unhandled goes nowhere (KineticWindow), so no key, held or
// not, beeps or takes the window out of fullscreen. The bundle holds only
// this binary, its icon and Info.plist; the media stays in the folder
// beside it.
//
// It reopens the way it was left, fullscreen (the first launch) or in a
// window, with no fullscreen flash when it opens windowed. The page's Esc
// screen asks it to quit or to switch between the two over the shared
// bridge (KineticHostBridge, apps/README.md), and every switch, the
// reader's own green button, menu item or ⌃⌘F included, reaches the page.
// The first window is the game's first graphic's size and shape (baked
// into Info.plist by build_apps.py), scaled down to fit the screen; after
// that the reader's size and place are kept.
//
// It offers spoken lines (docs/plan.md Phase 52): one VoiceEngine
// (../VoiceEngine.swift), passed to the bridge, downloads the voice install
// into the machine's shared voice folder when the page asks and runs the
// voice helper, which the binary carries; it stops the helper at quit.

import AppKit
import WebKit

/// The game's name, which build_apps.py writes into Info.plist from the
/// manifest title, for the menus and the window's first title.
let gameTitle =
    Bundle.main.object(forInfoDictionaryKey: "KineticTitle") as? String
    ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
    ?? "Kinetic"

/// UserDefaults keys (under the app's bundle id): the display mode it was
/// left in, and its window's frame the last time it was a window.
let displayKey = "KineticDisplay"
let frameKey = "KineticWindowFrame"

/// The game window's first content size: the first graphic's pixel size,
/// which build_apps.py writes as Info.plist `KineticWindowSize` ({Width,
/// Height}); 16:9 at 1280 x 720 when the build had none.
func firstContentSize() -> NSSize {
    let baked = Bundle.main.object(forInfoDictionaryKey: "KineticWindowSize") as? [String: Any]
    let width = (baked?["Width"] as? NSNumber)?.doubleValue ?? 0
    let height = (baked?["Height"] as? NSNumber)?.doubleValue ?? 0
    return width >= 1 && height >= 1 ? NSSize(width: width, height: height) : NSSize(width: 1280, height: 720)
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate,
    WKUIDelegate, WKDownloadDelegate
{
    /// The game's one window: a KineticWindow (../WebViewSetup.swift),
    /// which drops every key the page leaves unhandled, so no key beeps or
    /// takes it out of fullscreen. Only the Esc screen's switch, the green
    /// button, the View menu and ⌃⌘F change its mode.
    var window: KineticWindow!
    var webView: WKWebView!
    var bridge: KineticHostBridge!
    /// Spoken lines: the voice folder, the download and the helper.
    let voice = VoiceEngine()
    var titleObservation: NSKeyValueObservation?
    /// From the moment the window starts into fullscreen until it is a
    /// window again: its frame then is not the reader's to keep.
    var fullScreen = false

    static let style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable, .resizable]

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let page = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: page.path) else {
            explainMissingGame()
            NSApp.terminate(nil)
            return
        }

        let remembered = UserDefaults.standard.string(forKey: displayKey)
            .flatMap(KineticHostBridge.Display.init(rawValue:)) ?? .fullscreen

        // On disk under this app's bundle id, so progress survives a quit.
        let config = KineticWebView.configuration(storage: .persistent)
        // The page's Exit and Fullscreen / Window (the Esc screen).
        bridge = KineticHostBridge(
            kind: "mac-app", display: remembered, voice: voice,
            onQuit: { NSApp.terminate(nil) },
            onDisplay: { [weak self] mode in self?.show(mode) })
        bridge.install(on: config.userContentController)

        let content = NSWindow.contentRect(forFrameRect: windowedFrame(), styleMask: Self.style)
        webView = KineticWebView.make(frame: NSRect(origin: .zero, size: content.size), configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = KineticWindow(contentRect: content, styleMask: Self.style, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.title = gameTitle
        window.backgroundColor = .black
        window.contentMinSize = NSSize(width: 480, height: 270)
        window.collectionBehavior = [.fullScreenPrimary]
        window.contentView = webView
        window.delegate = self
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(webView)
        // Fullscreen as a window, not the page's element fullscreen, so Esc
        // and reload keep it. Left windowed, it opens as a window.
        if remembered == .fullscreen { window.toggleFullScreen(nil) }
        titleObservation = webView.observe(\.title) { [weak self] view, _ in
            if let title = view.title, !title.isEmpty { self?.window.title = title }
        }
        KineticWebView.load(webView, page: page)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The page asked for a display mode.
    func show(_ mode: KineticHostBridge.Display) {
        let isFull = window.styleMask.contains(.fullScreen)
        if (mode == .fullscreen) != isFull {
            window.toggleFullScreen(nil)
        } else {
            bridge.setDisplay(isFull ? .fullscreen : .window, in: webView)
        }
    }

    // MARK: the window's place, size and mode

    /// The window's frame as a window: where the reader left it, or the
    /// first size, centred on the main screen.
    func windowedFrame() -> NSRect {
        if let saved = UserDefaults.standard.string(forKey: frameKey).map(NSRectFromString),
            saved.width >= 200, saved.height >= 150,
            NSScreen.screens.contains(where: {
                let shared = $0.visibleFrame.intersection(saved)
                return shared.width >= 100 && shared.height >= 100
            })
        {
            return saved
        }
        return firstFrame()
    }

    /// The first graphic's size and shape, scaled down to fit the screen's
    /// visible area with a margin, centred.
    func firstFrame() -> NSRect {
        let visible = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let margin = max(24, min(visible.width, visible.height) * 0.04)
        let content = firstContentSize()
        let chrome = NSWindow.frameRect(forContentRect: NSRect(origin: .zero, size: content), styleMask: Self.style)
            .size
        let extraW = chrome.width - content.width, extraH = chrome.height - content.height
        let scale = min(
            1, (visible.width - 2 * margin - extraW) / content.width,
            (visible.height - 2 * margin - extraH) / content.height)
        let size = NSSize(
            width: (content.width * scale).rounded(.down) + extraW,
            height: (content.height * scale).rounded(.down) + extraH)
        return NSRect(
            x: (visible.midX - size.width / 2).rounded(), y: (visible.midY - size.height / 2).rounded(),
            width: size.width, height: size.height)
    }

    func keepFrame() {
        guard !fullScreen, window != nil else { return }
        UserDefaults.standard.set(NSStringFromRect(window.frame), forKey: frameKey)
    }

    func remember(_ mode: KineticHostBridge.Display) {
        UserDefaults.standard.set(mode.rawValue, forKey: displayKey)
    }

    // The page hears of a switch as it starts, whoever asked for it; the
    // app remembers it once it is done.
    func windowWillEnterFullScreen(_ notification: Notification) {
        fullScreen = true
        bridge.setDisplay(.fullscreen, in: webView)
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        remember(.fullscreen)
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        fullScreen = false
        bridge.setDisplay(.window, in: webView)
    }

    func windowWillExitFullScreen(_ notification: Notification) {
        bridge.setDisplay(.window, in: webView)
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        fullScreen = false
        remember(.window)
        keepFrame()
    }

    func windowDidFailToExitFullScreen(_ window: NSWindow) {
        bridge.setDisplay(.fullscreen, in: webView)
    }

    func windowDidMove(_ notification: Notification) { keepFrame() }
    func windowDidResize(_ notification: Notification) { keepFrame() }

    // MARK: launch and close

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

    // Closing the window ends the game; a double-click while it runs just
    // brings it forward.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        voice.shutdown()
    }

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