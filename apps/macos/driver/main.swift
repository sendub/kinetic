// The scenario suite's WebKit driver (docs/verify-player.md, "WebKit"). It
// hosts the system WebKit with the game app's own web view setup
// (../WebViewSetup.swift) and takes JSON-lines requests on stdin, writing
// one reply line per request on stdout ({"id","ok","value"|"error"}) plus
// {"event":...} lines: ready, navigated, console, pageerror, hosterror,
// download, filechooser, hostmessage, hostlanguage, windowclose, windowkey,
// keyequivalent, fatal. One process is one fresh profile (a non-persistent data store),
// unless it is started with `--profile=<dir>`: then its storage is kept on
// disk in that folder (WebKit's private directory-rooted data store), so a
// later process given the same folder finds it again. player/scripts/webkit/
// builds and drives it; player/scripts/testing/ opens creators' games in it.
//
// The `host` request installs the game app's own page-to-host bridge
// (KineticHostBridge in ../WebViewSetup.swift) with a recording host: each
// message the page sends becomes a hostmessage line, and `hostDisplay` sets
// the host's display mode as the reader's green button would, so the page
// gets its `kinetic-host` event. The page's `language` message (docs/plan.md
// Phase 56 item 7) is a hostmessage line too, and the driver then does with
// it what the game app does, through the same ../HostWords.swift: its
// window takes the title the page shows, and a hostlanguage line reports
// that title, the catalogue language the words were looked up in and the
// game app's menu words for it. The `hostWords` request answers, for lists
// of preferred languages, the language the game app would pick before the
// page loads and its missing-game alert's words, and the same pick for the
// driver's own Locale.preferredLanguages (`-AppleLanguages` sets them).
// Without it the page runs as in a browser
// tab, which may ask to close itself (a windowclose line). With `voice:
// true` the bridge also gets the game app's own voice host (VoiceEngine in
// ../VoiceEngine.swift), set up from the environment the driver was
// started with (KINETIC_VOICE_DIR and the other test overrides), and the
// page speaks to it exactly as in the app; the helper stops when the
// driver quits.
//
// Started with `--require-gesture-for-audio` (test only), sound waits for a
// key or click as in Safari; the game app needs none. The page is always
// muted, so nothing the driver plays is heard. The `visible` request
// hides or shows the page (document.visibilityState), as minimising the
// game app's window would.
//
// The window is the game app's own class (KineticWindow): a key the page
// leaves unhandled comes back to it from the web view, and each one becomes
// a windowkey line, "dropped" where KineticWindow drops it, "appkit" if it
// ever reaches NSWindow's own keyDown. A `key` request with `autoRepeat`
// sends a held key's repeat (isARepeat), as CDP's does. A keyDown held with
// ⌘ (CDP's `modifiers` bit 4) goes through NSApp, where DriverApplication
// offers it to the window as a key equivalent first, as AppKit does in the
// game app, and reports the window's answer as a keyequivalent line.
//
// Nothing of it can be seen or take focus: an accessory app (no Dock icon,
// no menu bar) that never activates, its one borderless window placed off
// every screen. It checks that placement before it shows the window and
// whenever the screens change, and quits rather than show it. Private
// WebKit hooks make the page run as if it were in front (no occlusion, no
// hidden-page throttling) and let input in without activating the app; the
// ready line reports each one, and the adapter refuses to run without all
// of them.

import AppKit
import WebKit

/// The game app's own window class (KineticWindow, ../WebViewSetup.swift),
/// so its key handling is what the suite tests, placed off screen.
final class DriverWindow: KineticWindow {
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // The page sees an active, focused window, as a player in front does
    // (WebKit reads this for document.hasFocus() and mouse-move delivery);
    // the app itself never activates, so the user's focus stays put.
    override var isKeyWindow: Bool { true }
    override var isMainWindow: Bool { true }
    // Where NSWindow's own keyDown ends, after AppKit's keyboard interface,
    // with a beep. KineticWindow never lets a key get here; one that does
    // is reported (a windowkey line, "appkit") and makes no sound.
    override func noResponder(for eventSelector: Selector) {
        if eventSelector == #selector(NSResponder.keyDown(with:)), let event = NSApp.currentEvent {
            reportWindowKey(event, "appkit")
        }
    }
}

/// A key event's code as CDP names it (KeyH, Escape).
func codeName(_ event: NSEvent) -> String {
    Driver.keyCodes.first { $0.value == event.keyCode }?.key ?? "keyCode \(event.keyCode)"
}

/// A key that came back from the web view to the window: `fate` is
/// "dropped" (KineticWindow kept it from AppKit) or "appkit" (it reached
/// NSWindow's own keyDown).
func reportWindowKey(_ event: NSEvent, _ fate: String) {
    emit(["event": "windowkey", "fate": fate, "code": codeName(event), "repeat": event.isARepeat])
}

/// The driver's NSApp. In the game app AppKit offers a keyDown held with ⌘
/// to the key window as a key equivalent (`performKeyEquivalent`: the page
/// first, through WKWebView), then to the main menu, and only then sends it
/// to the window as a keyDown. An app that never activates has no key
/// window, so AppKit skips that pass here; this class makes it on the
/// driver's window and reports the answer as a keyequivalent line. WKWebView
/// claims every key equivalent it is offered, to give the page its turn;
/// one the page leaves (no `preventDefault`) WebKit sends through NSApp
/// again, and the web view's answer that time is the one that counts:
/// unclaimed, the game app's main menu gets the key (⌘Q quits the app). The
/// driver has no menu, so the key goes on to the window, as a key no menu
/// item takes does in the app.
final class DriverApplication: NSApplication {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, event.modifierFlags.contains(.command),
            let window = (delegate as? Driver)?.window, event.windowNumber == window.windowNumber
        {
            let claimed = window.performKeyEquivalent(with: event)
            emit(["event": "keyequivalent", "code": codeName(event), "claimed": claimed])
            if claimed { return }
        }
        super.sendEvent(event)
    }
}

/// Calls a private `-(void)sel:(BOOL)` setter when this WebKit has it.
func setPrivateBool(_ target: NSObject, _ name: String, _ value: Bool) -> Bool {
    let sel = NSSelectorFromString(name)
    guard target.responds(to: sel) else { return false }
    typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
    unsafeBitCast(target.method(for: sel), to: Setter.self)(target, sel, value)
    return true
}

/// Calls a private `-(void)sel:(double)` setter when this WebKit has it.
func setPrivateDouble(_ target: NSObject, _ name: String, _ value: Double) -> Bool {
    let sel = NSSelectorFromString(name)
    guard target.responds(to: sel) else { return false }
    typealias Setter = @convention(c) (AnyObject, Selector, Double) -> Void
    unsafeBitCast(target.method(for: sel), to: Setter.self)(target, sel, value)
    return true
}

/// Mutes the page's sound through WebKit's private `-[WKWebView
/// _setPageMuted:]` (`_WKMediaAudioMuted`, bit 0), read back through
/// `_mediaMutedState`; false when this WebKit lacks either or the bit did
/// not stick.
func mutePageAudio(_ webView: WKWebView) -> Bool {
    let setSel = NSSelectorFromString("_setPageMuted:")
    let getSel = NSSelectorFromString("_mediaMutedState")
    guard webView.responds(to: setSel), webView.responds(to: getSel) else { return false }
    typealias Setter = @convention(c) (AnyObject, Selector, Int) -> Void
    typealias Getter = @convention(c) (AnyObject, Selector) -> Int
    unsafeBitCast(webView.method(for: setSel), to: Setter.self)(webView, setSel, 1)
    return unsafeBitCast(webView.method(for: getSel), to: Getter.self)(webView, getSel) & 1 != 0
}

/// A persistent data store kept wholly inside `dir`, through WebKit's
/// private `-[_WKWebsiteDataStoreConfiguration initWithDirectory:]` and
/// `+[WKWebsiteDataStore _storeWithConfiguration:]`; nil when this WebKit
/// lacks either. (The public persistent stores live under ~/Library.)
func folderStore(_ dir: URL) -> WKWebsiteDataStore? {
    let initSel = NSSelectorFromString("initWithDirectory:")
    let makeSel = NSSelectorFromString("_storeWithConfiguration:")
    guard let cls = NSClassFromString("_WKWebsiteDataStoreConfiguration") as? NSObject.Type,
        cls.instancesRespond(to: initSel), WKWebsiteDataStore.responds(to: makeSel),
        let raw = cls.perform(NSSelectorFromString("alloc"))?.takeUnretainedValue()
    else { return nil }
    typealias Init = @convention(c) (AnyObject, Selector, NSURL) -> AnyObject?
    let initialize = unsafeBitCast(class_getMethodImplementation(cls, initSel), to: Init.self)
    guard let config = initialize(raw, initSel, dir as NSURL) else { return nil }
    return WKWebsiteDataStore.perform(makeSel, with: config)?.takeUnretainedValue() as? WKWebsiteDataStore
}

/// The folder named by `--profile=<dir>`, created if need be; nil without
/// the argument (a fresh in-memory profile).
func profileFolder() -> URL? {
    guard let arg = CommandLine.arguments.first(where: { $0.hasPrefix("--profile=") }) else { return nil }
    let dir = URL(fileURLWithPath: String(arg.dropFirst("--profile=".count)), isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
        fatal("cannot create the profile folder \(dir.path): \(error.localizedDescription)")
    }
    return dir
}

/// The mouse buttons the driver holds down (bit 0, the left one), which is
/// what `+[NSEvent pressedMouseButtons]` answers in this process. WebKit
/// reads that class method, the machine's real mouse, for the `buttons` of
/// each mouse event it hands the page. With the real answer a press sent
/// here reached the page unpressed (`pointerdown` with `buttons` 0), and
/// one that met the user's own button held down anywhere on the machine
/// reached it as a chorded press or release (Pointer Events): a
/// `pointermove` with `buttons` 1 in place of the `pointerdown` or the
/// `pointerup`. The map then never saw the press begin or end: a drag
/// scrolled nothing, a card click opened nothing, and later moves dragged.
/// WebKit's own test runner answers it from its simulated buttons too. The
/// game app keeps the real answer.
var driverButtons = 0
func answerPressedMouseButtonsFromDriver() -> Bool {
    guard let method = class_getClassMethod(NSEvent.self, NSSelectorFromString("pressedMouseButtons")) else {
        return false
    }
    let answer: @convention(block) (AnyObject) -> Int = { _ in driverButtons }
    method_setImplementation(method, imp_implementationWithBlock(answer))
    return true
}

let outLock = NSLock()
func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    outLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    outLock.unlock()
}

/// Reports a reason the driver cannot go on, and quits.
func fatal(_ message: String) -> Never {
    emit(["event": "fatal", "error": message])
    exit(2)
}

// Counts the input events the page has received, so an input request can
// answer only once the page has handled it (CDP's Input.* contract), and
// forwards the console and page errors. A mouse event is counted by its
// pointer event, which every one of them fires: a page that cancels a
// `pointerdown` (the branch map does) gets no `mousedown`, `mousemove` or
// `mouseup` until the release, and counting those left each press there
// unconfirmed for the request's whole limit.
let pageShim = """
    (() => {
      const counts = { keydown: 0, keyup: 0, pointerdown: 0, pointerup: 0, pointermove: 0, wheel: 0 };
      Object.defineProperty(window, "__kdrv", { value: counts });
      for (const type of Object.keys(counts))
        window.addEventListener(type, () => { counts[type] += 1; }, { capture: true, passive: true });
      const post = (type, text) => { try { webkit.messageHandlers.kdrv.postMessage({ type, text: String(text) }); } catch {} };
      const fmt = (args) => args.map((a) => { try { return typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a); } catch { return String(a); } }).join(" ");
      for (const [name, type] of [["error", "error"], ["warn", "warning"], ["log", "log"], ["info", "info"]]) {
        const original = console[name].bind(console);
        console[name] = (...args) => { post(type, fmt(args)); original(...args); };
      }
      window.addEventListener("error", (e) => post("pageerror", e.message || String(e.error)));
      window.addEventListener("unhandledrejection", (e) => post("pageerror", (e.reason && e.reason.message) || String(e.reason)));
    })();
    """

struct DriverError: Error, CustomStringConvertible { let description: String }

final class Driver: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler,
    WKUIDelegate, WKDownloadDelegate
{
    var window: DriverWindow!
    var webView: WKWebView!
    var navigationWaiters: [(Result<Void, Error>) -> Void] = []
    var downloadDir: URL?
    var chooserFiles: [URL]?
    var pendingChooser: (([URL]?) -> Void)?
    var bridge: KineticHostBridge?
    var voice: VoiceEngine?

    // MARK: placement

    /// A frame of `size` far below and left of every screen.
    func offscreenFrame(_ size: NSSize) -> NSRect {
        let union = NSScreen.screens.reduce(NSRect.null) { $0.union($1.frame) }
        let left = union.isNull ? 0 : union.minX
        let bottom = union.isNull ? 0 : union.minY
        return NSRect(
            x: min(-30000, left - 10000) - size.width,
            y: min(-30000, bottom - 10000) - size.height,
            width: size.width, height: size.height)
    }

    /// The screen `frame` would show on, if any.
    func screenShowing(_ frame: NSRect) -> NSScreen? {
        NSScreen.screens.first { $0.frame.intersects(frame) }
    }

    /// Moves the window to `size` off every screen, checking the frame
    /// before and after: a window that would show is hidden and the driver
    /// quits.
    func place(_ size: NSSize) {
        let frame = offscreenFrame(size)
        if let screen = screenShowing(frame) {
            if window.isVisible { window.orderOut(nil) }
            fatal("the driver window \(frame) would show on screen \(screen.frame); refusing to show it")
        }
        window.setFrame(frame, display: true)
        if let screen = screenShowing(window.frame) {
            window.orderOut(nil)
            fatal("the driver window landed at \(window.frame), on screen \(screen.frame); hid it and quit")
        }
    }

    // MARK: startup

    func applicationDidFinishLaunching(_ notification: Notification) {
        let config = KineticWebView.configuration(storage: .nonPersistent)
        // Test only: sound waits for a key or click, as in Safari, so the
        // player's unlock and its hint are tested on WebKit too. The game
        // app keeps the configuration's default (no gesture needed).
        let gestureForAudio = CommandLine.arguments.contains("--require-gesture-for-audio")
        if gestureForAudio { config.mediaTypesRequiringUserActionForPlayback = .audio }
        let profile = profileFolder()
        if let profile {
            guard let store = folderStore(profile) else {
                fatal("this macOS's WebKit cannot keep a profile in a folder (it lacks the private _WKWebsiteDataStoreConfiguration initWithDirectory:); open without a profile, or on Chrome")
            }
            config.websiteDataStore = store
        }
        guard answerPressedMouseButtonsFromDriver() else {
            fatal("cannot answer +[NSEvent pressedMouseButtons] from the driver's own buttons")
        }
        // Test hooks: the page runs as if in front although no one sees it.
        var hooks: [String: Bool] = [:]
        for name in ["_setHiddenPageDOMTimerThrottlingEnabled:", "_setPageVisibilityBasedProcessSuppressionEnabled:"] {
            hooks[name] = setPrivateBool(config.preferences, name, false)
        }
        let controller = config.userContentController
        controller.add(self, name: "kdrv")
        controller.addUserScript(WKUserScript(source: pageShim, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let size = NSSize(width: 800, height: 600)
        window = DriverWindow(
            contentRect: offscreenFrame(size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.keyDropped = { reportWindowKey($0, "dropped") }
        window.hasShadow = false
        window.isExcludedFromWindowsMenu = true
        // Left out of Mission Control, Exposé and window cycling.
        window.collectionBehavior = [.transient, .ignoresCycle]
        window.acceptsMouseMovedEvents = true
        webView = KineticWebView.make(frame: window.contentView!.bounds, configuration: config)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        hooks["_setWindowOcclusionDetectionEnabled:"] =
            setPrivateBool(webView, "_setWindowOcclusionDetectionEnabled:", false)
        // No test makes a sound. WebKit offers no fake output stream (as
        // Chrome's --disable-audio-output is), so the page is muted: each
        // player is muted before it starts and its Core Audio output plays
        // zeros. Elements still play, their clocks and events run, and
        // `muted`, `volume` and the gesture rule (which reads the element's
        // own muted and volume) are unchanged (measured on macOS 27.2,
        // 2026-11-10). The game app plays sound.
        hooks["_setPageMuted:"] = mutePageAudio(webView)
        // Headless Chrome renders at 1x; match it so screenshots and the
        // device-pixel logic compare (setViewport may ask for another).
        hooks["_setOverrideDeviceScaleFactor:"] = setPrivateDouble(webView, "_setOverrideDeviceScaleFactor:", 1)
        // Mouse moves reach a view only in a key window of the active app;
        // WebKit's own test hook feeds them in as real moves.
        hooks["_simulateMouseMove:"] = webView.responds(to: NSSelectorFromString("_simulateMouseMove:"))
        // Input sent before the page's first layer-tree commit is dropped;
        // navigation answers once the page has presented.
        hooks["_doAfterNextPresentationUpdate:"] =
            webView.responds(to: NSSelectorFromString("_doAfterNextPresentationUpdate:"))
        window.contentView!.addSubview(webView)

        place(size)
        window.orderFrontRegardless()
        window.makeFirstResponder(webView)
        if let screen = screenShowing(window.frame) {
            window.orderOut(nil)
            fatal("the driver window shows at \(window.frame) on screen \(screen.frame); hid it and quit")
        }
        let center = NotificationCenter.default
        center.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) {
            [weak self] _ in
            guard let self else { return }
            self.place(self.window.frame.size)
        }
        center.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            // Never expected: hand focus straight back and fail the run.
            NSApp.deactivate()
            emit(["event": "hosterror", "text": "the WebKit driver became the active app"])
        }
        emit([
            "event": "ready", "hooks": hooks, "offscreen": "\(window.frame)", "pid": getpid(),
            "profile": profile?.path ?? NSNull(), "gestureForAudio": gestureForAudio,
        ])

        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                guard let data = line.data(using: .utf8),
                    let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                DispatchQueue.main.async { self.handle(request) }
            }
            // The adapter went away: so does the driver.
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        voice?.shutdown()
    }

    // MARK: requests

    func reply(_ id: Any, _ result: Result<Any, Error>) {
        switch result {
        case .success(let value): emit(["id": id, "ok": true, "value": value])
        case .failure(let error): emit(["id": id, "ok": false, "error": "\(error)"])
        }
    }

    func handle(_ r: [String: Any]) {
        let id = r["id"] ?? NSNull()
        let cmd = r["cmd"] as? String ?? ""
        switch cmd {
        case "goto":
            guard let url = URL(string: r["url"] as? String ?? "") else {
                reply(id, .failure(DriverError(description: "goto: bad url")))
                return
            }
            waitForNavigation { self.reply(id, $0.map { _ in self.webView.url?.absoluteString ?? "" }) }
            if url.isFileURL {
                KineticWebView.load(webView, page: url)
            } else {
                webView.load(URLRequest(url: url))
            }
        case "reload":
            waitForNavigation { self.reply(id, $0.map { _ in true }) }
            webView.reload()
        case "eval":
            // `body` is an async function body; it returns a JSON string.
            webView.callAsyncJavaScript(r["body"] as? String ?? "", arguments: [:], in: nil, in: .page) {
                result in
                self.reply(id, result.map { $0 as Any })
            }
        case "addScript":
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: r["source"] as? String ?? "", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            reply(id, .success(true))
        case "viewport":
            let w = r["width"] as? Double ?? 800, h = r["height"] as? Double ?? 600
            _ = setPrivateDouble(webView, "_setOverrideDeviceScaleFactor:", r["scale"] as? Double ?? 1)
            place(NSSize(width: w, height: h))
            // Answer once the page sees the new size.
            webView.callAsyncJavaScript(
                "const t0 = performance.now(); while ((innerWidth !== w || innerHeight !== h) && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5)); return innerWidth + 'x' + innerHeight;",
                arguments: ["w": w, "h": h], in: nil, in: .page
            ) { self.reply(id, $0.map { $0 as Any }) }
        case "screenshot":
            screenshot(r["clip"] as? [String: Double]) { self.reply(id, $0) }
        case "key":
            key(r) { self.reply(id, $0) }
        case "mouse":
            mouse(r) { self.reply(id, $0) }
        case "downloads":
            downloadDir = (r["dir"] as? String).map { URL(fileURLWithPath: $0) }
            reply(id, .success(true))
        case "chooser":
            // Answers the open panel already up, or the next one to open.
            let files = (r["files"] as? [String])?.map { URL(fileURLWithPath: $0) }
            if let pending = pendingChooser {
                pendingChooser = nil
                pending(files)
            } else {
                chooserFiles = files
            }
            reply(id, .success(true))
        case "host":
            // Before the first goto: the bridge's user script runs at
            // document start.
            guard bridge == nil,
                let display = KineticHostBridge.Display(rawValue: r["display"] as? String ?? "fullscreen")
            else {
                reply(id, .failure(DriverError(description: "host: already installed, or a bad display")))
                return
            }
            if r["voice"] as? Bool == true { voice = VoiceEngine(settings: .environment()) }
            let recorder = KineticHostBridge(
                kind: r["kind"] as? String ?? "mac-app", display: display, voice: voice,
                onQuit: { emit(["event": "hostmessage", "message": ["type": "quit"]]) },
                onDisplay: { emit(["event": "hostmessage", "message": ["type": "display", "mode": $0.rawValue]]) },
                onLanguage: { [weak self] language in self?.follow(language) })
            recorder.install(on: webView.configuration.userContentController)
            bridge = recorder
            reply(id, .success(true))
        case "hostWords":
            // For each list of preferred languages: the game app's pick
            // before the page loads, and its alert's words in it.
            let title = r["title"] as? String ?? "Kinetic"
            let answers = (r["requested"] as? [[String]] ?? []).map { requested -> [String: Any] in
                let language = HostWords.embedded.language(for: requested)
                return [
                    "language": language,
                    "alert": HostMissingGameAlert(HostWords.embedded, language: language, title: title).dictionary,
                ]
            }
            let preferred = Locale.preferredLanguages
            reply(
                id,
                .success([
                    "languages": HostWords.embedded.languages, "answers": answers,
                    "system": ["preferred": preferred, "language": HostWords.embedded.language(for: preferred)],
                ]))
        case "hostDisplay":
            guard let bridge, let mode = KineticHostBridge.Display(rawValue: r["mode"] as? String ?? "") else {
                reply(id, .failure(DriverError(description: "hostDisplay: no host installed, or a bad mode")))
                return
            }
            bridge.setDisplay(mode, in: webView) { self.reply(id, .success(true)) }
        case "visible":
            // The page hidden or shown, as when the game app's window is
            // minimised: the web view's own hidden flag, which WebKit turns
            // into document.visibilityState. Answers once the page sees it.
            let visible = r["visible"] as? Bool ?? true
            webView.isHidden = !visible
            webView.callAsyncJavaScript(
                "const t0 = performance.now(); while (document.visibilityState !== want && performance.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 5)); return document.visibilityState;",
                arguments: ["want": visible ? "visible" : "hidden"], in: nil, in: .page
            ) { self.reply(id, $0.map { $0 as Any }) }
        case "quit":
            reply(id, .success(true))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { NSApp.terminate(nil) }
        default:
            reply(id, .failure(DriverError(description: "unknown cmd \(cmd)")))
        }
    }

    /// The page's language message, as the game app follows it
    /// (app/main.swift `follow`): the window's title, and the menu words.
    func follow(_ language: HostLanguage) {
        var message: [String: Any] = ["type": "language", "ui": language.ui, "dir": language.dir]
        if let title = language.title { message["title"] = title }
        emit(["event": "hostmessage", "message": message])
        let title = language.shownTitle(or: "Kinetic")
        window.title = title
        let words = HostWords.embedded
        let looked = words.language(for: [language.ui])
        emit([
            "event": "hostlanguage", "language": looked, "windowTitle": window.title,
            "menu": HostMenuTitles(words, language: looked, title: title).dictionary,
        ])
    }

    func screenshot(_ clip: [String: Double]?, _ done: @escaping (Result<Any, Error>) -> Void) {
        let config = WKSnapshotConfiguration()
        if let clip {
            config.rect = NSRect(x: clip["x"] ?? 0, y: clip["y"] ?? 0, width: clip["width"] ?? 0, height: clip["height"] ?? 0)
            // In points: the image comes out at the view's device scale
            // factor (the override), as Chrome's capture does.
            config.snapshotWidth = NSNumber(value: clip["width"] ?? 0)
        } else {
            config.snapshotWidth = NSNumber(value: Double(webView.bounds.width))
        }
        webView.takeSnapshot(with: config) { image, error in
            guard let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else {
                done(.failure(error ?? DriverError(description: "snapshot failed")))
                return
            }
            // 72 dpi, as Chrome writes: a 4x capture otherwise carries
            // 288 dpi, and WebKit reads that as a quarter-size image.
            rep.size = NSSize(width: rep.pixelsWide, height: rep.pixelsHigh)
            guard let png = rep.representation(using: .png, properties: [:]) else {
                done(.failure(DriverError(description: "snapshot PNG failed")))
                return
            }
            done(.success(png.base64EncodedString()))
        }
    }

    // MARK: input

    /// Run `send`, then answer once the page's `counter` passed its value
    /// from before (or after `limit` seconds, answering delivered: false).
    func delivered(_ counter: String, limit: Double, _ send: @escaping () -> Void,
                   _ done: @escaping (Result<Any, Error>) -> Void)
    {
        webView.callAsyncJavaScript("return window.__kdrv ? window.__kdrv[c] : -1;", arguments: ["c": counter], in: nil, in: .page) {
            before in
            let start = (try? before.get()) as? Int ?? -1
            send()
            if start < 0 { done(.success(["delivered": false, "reason": "no shim"])); return }
            self.webView.callAsyncJavaScript(
                "const t0 = performance.now(); while (window.__kdrv[c] <= n) { if (performance.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 1)); } return true;",
                arguments: ["c": counter, "n": start, "ms": limit * 1000], in: nil, in: .page
            ) { result in
                done(.success(["delivered": ((try? result.get()) as? Bool) ?? false]))
            }
        }
    }

    static let keyCodes: [String: UInt16] = [
        "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5, "KeyZ": 6, "KeyX": 7, "KeyC": 8,
        "KeyV": 9, "KeyB": 11, "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
        "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23, "Equal": 24,
        "Digit9": 25, "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29, "BracketRight": 30, "KeyO": 31,
        "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35, "Enter": 36, "KeyL": 37, "KeyJ": 38,
        "Quote": 39, "KeyK": 40, "Semicolon": 41, "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45,
        "KeyM": 46, "Period": 47, "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
        "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Delete": 117,
        "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
    ]
    static let specialChars: [String: String] = [
        "Escape": "\u{1b}", "Tab": "\t", "Enter": "\r", "Backspace": "\u{7f}",
        "ArrowUp": "\u{F700}", "ArrowDown": "\u{F701}", "ArrowLeft": "\u{F702}", "ArrowRight": "\u{F703}",
        "Delete": "\u{F728}", "Home": "\u{F729}", "End": "\u{F72B}", "PageUp": "\u{F72C}", "PageDown": "\u{F72D}",
    ]

    /// CDP's modifier bits (1 Alt, 2 Ctrl, 4 Meta, 8 Shift) as AppKit flags.
    static func modifierFlags(_ bits: Int) -> NSEvent.ModifierFlags {
        var flags: NSEvent.ModifierFlags = []
        if bits & 1 != 0 { flags.insert(.option) }
        if bits & 2 != 0 { flags.insert(.control) }
        if bits & 4 != 0 { flags.insert(.command) }
        if bits & 8 != 0 { flags.insert(.shift) }
        return flags
    }

    func key(_ r: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void) {
        let type = r["type"] as? String ?? "keyDown"
        let code = r["code"] as? String ?? ""
        let keyName = r["key"] as? String ?? ""
        guard let keyCode = Driver.keyCodes[code] else {
            done(.failure(DriverError(description: "no mac key code for \(code)")))
            return
        }
        var chars = r["text"] as? String ?? ""
        if chars.isEmpty { chars = Driver.specialChars[keyName] ?? Driver.specialChars[code] ?? keyName }
        let unmodified = r["unmodifiedText"] as? String ?? chars
        var flags = Driver.modifierFlags(r["modifiers"] as? Int ?? 0)
        if code.hasPrefix("Arrow") { flags.formUnion([.function, .numericPad]) }
        let isUp = type == "keyUp"
        // CDP's autoRepeat: a held key's keydowns after the first.
        let event = NSEvent.keyEvent(
            with: isUp ? .keyUp : .keyDown, location: .zero, modifierFlags: flags,
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
            context: nil, characters: chars, charactersIgnoringModifiers: unmodified,
            isARepeat: !isUp && (r["autoRepeat"] as? Bool ?? false), keyCode: keyCode)!
        // A typed key reaches NSApp first; one held with ⌘ takes that path
        // (DriverApplication) so the window is offered it as a key
        // equivalent. Any other key NSApp would hand straight to the window.
        let viaApp = !isUp && flags.contains(.command)
        delivered(isUp ? "keyup" : "keydown", limit: 2, {
            if viaApp { NSApp.sendEvent(event) } else { self.window.sendEvent(event) }
        }, done)
    }

    func mouse(_ r: [String: Any], _ done: @escaping (Result<Any, Error>) -> Void) {
        let type = r["type"] as? String ?? "mouseMoved"
        let x = r["x"] as? Double ?? 0, y = r["y"] as? Double ?? 0
        let height = Double(window.contentView!.bounds.height)
        let point = NSPoint(x: x, y: height - y) // window coordinates: origin bottom-left
        let clicks = r["clickCount"] as? Int ?? 1
        let bits = r["modifiers"] as? Int ?? 0
        func mouseEvent(_ kind: NSEvent.EventType) -> NSEvent {
            NSEvent.mouseEvent(
                with: kind, location: point, modifierFlags: Driver.modifierFlags(bits),
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                context: nil, eventNumber: 0, clickCount: clicks, pressure: kind == .leftMouseUp ? 0 : 1)!
        }
        switch type {
        // Clicks go straight to the view: the window drops them because the
        // app is not active.
        case "mousePressed":
            driverButtons = 1
            delivered("pointerdown", limit: 1, { self.webView.mouseDown(with: mouseEvent(.leftMouseDown)) }, done)
        case "mouseReleased":
            driverButtons = 0
            delivered("pointerup", limit: 1, { self.webView.mouseUp(with: mouseEvent(.leftMouseUp)) }, done)
        case "mouseMoved":
            delivered("pointermove", limit: 0.5, {
                if driverButtons != 0 {
                    self.webView.mouseDragged(with: mouseEvent(.leftMouseDragged))
                } else {
                    self.webView.perform(NSSelectorFromString("_simulateMouseMove:"), with: mouseEvent(.mouseMoved))
                }
            }, done)
        case "mouseWheel":
            let dy = r["deltaY"] as? Double ?? 0, dx = r["deltaX"] as? Double ?? 0
            guard let cg = CGEvent(
                scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                wheel1: Int32(-dy.rounded()), wheel2: Int32(-dx.rounded()), wheel3: 0)
            else { done(.failure(DriverError(description: "no wheel event"))); return }
            // NSEvent(cgEvent:) gives a window-less event whose
            // locationInWindow is the CG point in bottom-left display
            // space, and WKWebView reads that as window coordinates: place
            // the CG point so it reads as the window-local point. A zero
            // timestamp reads as stale, so stamp it now.
            let screenTop = NSScreen.screens.first?.frame.maxY ?? 0
            cg.location = CGPoint(x: point.x, y: screenTop - point.y)
            cg.timestamp = CGEventTimestamp(ProcessInfo.processInfo.systemUptime * 1_000_000_000)
            var cgFlags: CGEventFlags = []
            if bits & 1 != 0 { cgFlags.insert(.maskAlternate) }
            if bits & 2 != 0 { cgFlags.insert(.maskControl) }
            if bits & 4 != 0 { cgFlags.insert(.maskCommand) }
            if bits & 8 != 0 { cgFlags.insert(.maskShift) }
            cg.flags = cgFlags
            guard let event = NSEvent(cgEvent: cg) else {
                done(.failure(DriverError(description: "no wheel NSEvent")))
                return
            }
            delivered("wheel", limit: 1, { self.webView.scrollWheel(with: event) }, done)
        default:
            done(.failure(DriverError(description: "unknown mouse type \(type)")))
        }
    }

    // MARK: navigation

    func waitForNavigation(_ done: @escaping (Result<Void, Error>) -> Void) { navigationWaiters.append(done) }

    func finishNavigation(_ result: Result<Void, Error>) {
        let waiters = navigationWaiters
        navigationWaiters = []
        for waiter in waiters { waiter(result) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Answer once the page has presented, as WebKit's own tests do.
        let block: @convention(block) () -> Void = {
            emit(["event": "navigated", "url": webView.url?.absoluteString ?? ""])
            self.finishNavigation(.success(()))
        }
        webView.perform(NSSelectorFromString("_doAfterNextPresentationUpdate:"), with: block)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishNavigation(.failure(error))
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishNavigation(.failure(error))
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        emit(["event": "pageerror", "text": "web content process terminated"])
    }
    /// The page's window.close() was allowed (a browser tab would close).
    func webViewDidClose(_ webView: WKWebView) {
        emit(["event": "windowclose"])
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        emit(["event": body["type"] as? String == "pageerror" ? "pageerror" : "console",
              "type": body["type"] ?? "log", "text": body["text"] ?? ""])
    }

    // MARK: downloads and the file chooser (Export / Import)

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void)
    {
        decisionHandler(KineticWebView.policy(for: navigationAction))
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void)
    {
        decisionHandler(KineticWebView.policy(for: navigationResponse))
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    /// Saves into the folder the adapter named (Browser.setDownloadBehavior);
    /// with none named, the download is refused.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void)
    {
        guard let dir = downloadDir else {
            emit(["event": "download", "refused": suggestedFilename])
            completionHandler(nil)
            return
        }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent(suggestedFilename)
        try? FileManager.default.removeItem(at: target)
        emit(["event": "download", "path": target.path])
        completionHandler(target)
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void)
    {
        emit(["event": "filechooser"])
        if let files = chooserFiles {
            chooserFiles = nil
            completionHandler(files)
        } else {
            pendingChooser = completionHandler
        }
    }
}

let app = DriverApplication.shared
let driver = Driver()
app.delegate = driver
app.setActivationPolicy(.accessory)
app.run()
