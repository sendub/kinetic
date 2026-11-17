// The voice host both macOS hosts run (docs/plan.md Phase 52 item 3;
// apps/README.md, "Spoken lines"): the game app and the scenario suite's
// WebKit driver compile this file, as they do WebViewSetup.swift, and pass
// one VoiceEngine to KineticHostBridge, which hands it the page's
// `{ type: "voice", op, ... }` messages and gives the page its events.
//
// It owns the machine's voice folder (`~/Library/Application Support/
// Kinetic/Voice/`, shared by every Kinetic app): it downloads and unpacks
// the private Python the lock names, writes the helper (apps/voice,
// embedded in the binary by the build as KineticVoiceEmbedded.swift) into
// `helper/`, runs the helper with JSON lines on its stdin and stdout, and
// relays between the page and the helper. The helper installs the packages
// and model files and voices lines (apps/voice/README.md).
//
// Threads: everything below runs on one serial queue (`queue`): the page's
// messages, the download's delegate calls (the session's delegate queue
// runs on it), the helper's lines (a reading thread hands each over) and
// its exit. Hashing and unpacking run on a global queue and hand the result
// back. Events reach the page on the main thread. Nothing blocks the main
// thread except `shutdown`, at quit.
//
// Test overrides, by environment (never set for readers; apps/README.md):
// KINETIC_VOICE_DIR (the voice folder), KINETIC_VOICE_DOWNLOAD_BASE (every
// download URL `https://host/path` becomes `<base>/host/path`, in the lock
// the helper reads too), KINETIC_VOICE_LOCK (a lock file in place of the
// embedded one), KINETIC_VOICE_PYTHON (a Python to run the helper with, no
// Python download) and KINETIC_VOICE_HELPER (a whole command line run with
// /bin/sh in place of the helper, no Python download).
//
// Builds for macOS 12 and later (the app's minimum).

import CryptoKit
import Foundation

/// A failure as the page gets it (docs/plan.md Phase 56 item 7;
/// apps/README.md, "The voice bridge"): `code` names it, which the page
/// words from the player's catalogue; `message` is an English detail for
/// the log; `fields` are the code's own numbers (`version`; `needBytes` and
/// `freeBytes`).
struct VoiceFailure: Error {
    let code: String
    let message: String
    var fields: [String: Any] = [:]
}

final class VoiceEngine: NSObject, KineticVoiceHost, URLSessionDataDelegate {
    /// Where the voice folder is and what the tests replace.
    struct Settings {
        var root: URL
        var downloadBase: String?
        var lockFile: String?
        var python: String?
        var helperCommand: String?

        /// A path given relative to the app's working directory, made
        /// absolute (the helper runs in the voice folder).
        static func absolute(_ path: String) -> String {
            URL(fileURLWithPath: path).standardizedFileURL.path
        }

        /// From the process's environment (the overrides are test-only).
        /// Relative paths are taken from the app's working directory, the
        /// helper command's too (it runs there, not in the voice folder).
        static func environment(_ env: [String: String] = ProcessInfo.processInfo.environment) -> Settings {
            func value(_ key: String) -> String? {
                guard let text = env[key], !text.isEmpty else { return nil }
                return text
            }
            let root = value("KINETIC_VOICE_DIR").map { URL(fileURLWithPath: $0, isDirectory: true) }
                ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Kinetic", isDirectory: true)
                .appendingPathComponent("Voice", isDirectory: true)
            return Settings(
                root: root.standardizedFileURL, downloadBase: value("KINETIC_VOICE_DOWNLOAD_BASE"),
                lockFile: value("KINETIC_VOICE_LOCK").map(absolute),
                python: value("KINETIC_VOICE_PYTHON").map(absolute),
                helperCommand: value("KINETIC_VOICE_HELPER"))
        }
    }

    /// The lock (apps/voice/README.md, "The lock"): what the install
    /// fetches. The app reads its `python` entry and its sizes.
    struct Lock {
        let id: String
        let pythonURL: String
        let pythonSHA256: String
        let pythonSize: Int64
        let wheels: [[String: Any]]
        let model: [[String: Any]]
        /// The lock as the helper gets it (URLs rewritten under test).
        let helperText: Data

        init(_ data: Data, downloadBase: String?) throws {
            guard var json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                let id = json["id"] as? String, let python = json["python"] as? [String: Any],
                let url = python["url"] as? String, let sha = python["sha256"] as? String,
                let size = VoiceEngine.int64(python["size"]), let wheels = json["wheels"] as? [[String: Any]],
                let model = json["model"] as? [[String: Any]]
            else { throw VoiceFailure(code: "lock-failed", message: "The voice lock file is not readable.") }
            self.id = id
            pythonSHA256 = sha
            pythonSize = size
            self.wheels = wheels
            self.model = model
            pythonURL = VoiceEngine.redirect(url, to: downloadBase)
            guard let downloadBase else {
                helperText = data
                return
            }
            // The helper reads every URL from its lock: the rewritten lock
            // sends its downloads to the test server too.
            var rewritten = python
            rewritten["url"] = pythonURL
            json["python"] = rewritten
            json["wheels"] = wheels.map { wheel -> [String: Any] in
                var copy = wheel
                if let url = wheel["url"] as? String { copy["url"] = VoiceEngine.redirect(url, to: downloadBase) }
                return copy
            }
            json["modelBaseUrl"] = VoiceEngine.redirect(
                json["modelBaseUrl"] as? String ?? "https://huggingface.co", to: downloadBase)
            helperText = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        }

        /// The wheels this macOS takes, one per package, as the helper
        /// picks them (install.py, Lock.wheels): an entry without
        /// `minMacos`, or the newest build the system meets. Fails with the
        /// macOS needed when a package has no build for this one.
        func wheels(for system: OperatingSystemVersion) -> Result<[[String: Any]], VoiceFailure> {
            let mac = [system.majorVersion, system.minorVersion, system.patchVersion]
            var chosen: [String: [String: Any]] = [:]
            var names: [String] = []
            for entry in wheels {
                let name = entry["name"] as? String ?? ""
                if !names.contains(name) { names.append(name) }
                let need = entry["minMacos"] as? String
                if let need, mac.lexicographicallyPrecedes(VoiceEngine.version(need)) { continue }
                let best = chosen[name]
                if best == nil
                    || VoiceEngine.version(best?["minMacos"] as? String ?? "0").lexicographicallyPrecedes(
                        VoiceEngine.version(need ?? "0"))
                {
                    chosen[name] = entry
                }
            }
            let missing = names.filter { chosen[$0] == nil }
            if !missing.isEmpty {
                let oldest = wheels.filter { missing.contains($0["name"] as? String ?? "") }
                    .compactMap { $0["minMacos"] as? String }
                    .min { VoiceEngine.version($0).lexicographicallyPrecedes(VoiceEngine.version($1)) } ?? "?"
                return .failure(
                    VoiceFailure(
                        code: "macos-version", message: "Spoken lines need macOS \(oldest) or later.",
                        fields: ["version": oldest]))
            }
            return .success(names.compactMap { chosen[$0] })
        }

        /// What the helper's install fetches on this system (the wheels it
        /// picks and the model files): the one place the app works it out
        /// while the helper cannot run.
        func helperBytes(for system: OperatingSystemVersion) -> Int64? {
            guard case .success(let picked) = wheels(for: system) else { return nil }
            return (picked + model).reduce(0) { $0 + (VoiceEngine.int64($1["size"]) ?? 0) }
        }
    }

    /// What the page sees (`{ event: "status", state }`).
    enum State: String {
        case absent, installing, ready, error, unsupported
    }

    /// One install the page started: the Python download, its unpacking,
    /// then the helper's own install.
    private final class Install {
        var cancelled = false
        /// The page asked to remove while this ran: remove once it stops.
        var thenRemove = false
        var task: URLSessionDataTask?
        var file: FileHandle?
        var have: Int64 = 0
        var failure: VoiceFailure?
        var helperRequest: Int?
    }

    /// The running helper.
    private final class Helper {
        let process: Process
        let input: FileHandle
        /// Stopped by the app (remove, quit): its exit is no crash.
        var stopping = false

        init(process: Process, input: FileHandle) {
            self.process = process
            self.input = input
        }
    }

    /// A request sent to the helper and not yet answered. `request` is kept
    /// to send again to a restarted helper; `reply` gets the answer (or a
    /// failure made up when the helper is gone) and whether the page has
    /// dropped it.
    private struct Pending {
        let request: [String: Any]
        let pageId: Any?
        var dropped = false
        let reply: ([String: Any], Bool) -> Void
    }

    static let helperLogLimit: UInt64 = 4 << 20
    static let diskMargin: Int64 = 1 << 30
    static let pythonMarker = ".kinetic-python"
    /// What `remove` deletes (the helper's own `remove` takes its share
    /// first, when it can run): every file of the install. The voice folder
    /// itself goes too once it is empty.
    static let installFiles = [
        "python", "python.partial", "downloads", "helper", "lib", "lib.partial", "models", "cache",
        "state.json", "helper.log",
    ]

    let settings: Settings
    var deliver: (([String: Any]) -> Void)?

    private let queue = DispatchQueue(label: "org.kinetic.voice")
    private lazy var session: URLSession = {
        let operations = OperationQueue()
        operations.underlyingQueue = queue
        operations.maxConcurrentOperationCount = 1
        return URLSession(configuration: .ephemeral, delegate: self, delegateQueue: operations)
    }()
    private lazy var lockLoad: Result<Lock, VoiceFailure> = loadLock()

    // The state, on `queue` only.
    private var state: State?
    private var message: String?
    /// With `error` and `unsupported`: the failure's code and numbers.
    private var failure: VoiceFailure?
    private var downloadBytes: Int64 = 0
    private var done: Int64 = 0
    private var total: Int64 = 0
    private var lastProgress: TimeInterval = 0
    private var install: Install?
    private var helper: Helper?
    private var nextRequest = 1
    private var pending: [Int: Pending] = [:]
    /// Each voice the page registered, by voiceId: its `voice` request,
    /// sent again to a restarted helper.
    private var registrations: [String: [String: Any]] = [:]
    private var crashes = 0
    private var log: FileHandle?

    init(settings: Settings = .environment()) {
        self.settings = settings
        super.init()
        // A write to a helper that has just died must fail, not kill the app.
        signal(SIGPIPE, SIG_IGN)
    }

    private var root: URL { settings.root }
    private var fileManager: FileManager { .default }
    private func path(_ name: String) -> URL { root.appendingPathComponent(name) }

    // MARK: the bridge's side (main thread)

    func receive(_ message: [String: Any]) {
        queue.async { self.handle(message) }
    }

    /// Stops the helper and any download; the app is quitting.
    func shutdown() {
        queue.sync {
            install?.task?.cancel()
            if let helper {
                helper.stopping = true
                try? helper.input.close()
                helper.process.terminate()
            }
            helper = nil
        }
    }

    // MARK: page messages

    private func handle(_ message: [String: Any]) {
        let op = message["op"] as? String ?? ""
        let id = message["id"]
        switch op {
        case "status": status()
        case "install": startInstall()
        case "cancel": cancelInstall()
        case "remove": remove()
        case "voice":
            var fields: [String: Any] = ["voice": message["data"] ?? NSNull(), "format": message["format"] ?? "wav"]
            if let text = message["text"] { fields["text"] = text }
            relay(id, "voice", fields)
        case "speak":
            var fields = message
            for key in ["type", "op", "id"] { fields.removeValue(forKey: key) }
            relay(id, "speak", fields)
        case "drop": drop(id)
        default:
            send(["event": "error", "id": id ?? NSNull(), "code": "unknown-op", "message": "Unknown voice request \(op)."])
        }
    }

    private func status() {
        guard let lock = currentLock() else { return }
        if let reason = unsupported(lock) {
            setState(.unsupported, failure: reason)
            return
        }
        if install != nil {
            push()
            return
        }
        // A status after an error tries again from the start.
        if state == .error { crashes = 0 }
        guard helper != nil || installComplete(lock) else {
            downloadBytes = fullDownload(lock)
            setState(.absent)
            return
        }
        guard startHelper(lock) else { return }
        request("status", [:]) { [weak self] reply, _ in self?.statusAnswered(reply, lock) }
    }

    private func statusAnswered(_ reply: [String: Any], _ lock: Lock) {
        guard install == nil else { return }
        if reply["ok"] as? Bool == true {
            if let bytes = Self.int64(reply["downloadBytes"]) { downloadBytes = pythonBytes(lock) + bytes }
            setState(reply["installed"] as? Bool == true ? .ready : .absent)
        } else if reply["code"] as? String == "unsupported-system" {
            setState(
                .unsupported,
                failure: VoiceFailure(
                    code: "unsupported-system", message: "Spoken lines need a newer macOS (\(reply["error"] ?? ""))."))
        } else {
            setState(
                .error,
                failure: VoiceFailure(
                    code: "helper-failed",
                    message: "The voice helper could not report its state: \(reply["error"] ?? "unknown error")."))
        }
    }

    private func startInstall() {
        guard let lock = currentLock() else { return }
        if let reason = unsupported(lock) {
            setState(.unsupported, failure: reason)
            return
        }
        if install != nil {
            push()
            return
        }
        crashes = 0
        let full = fullDownload(lock)
        if !installComplete(lock), let free = freeBytes(), free < full + Self.diskMargin {
            setState(
                .error,
                failure: VoiceFailure(
                    code: "disk-space",
                    message: "Spoken lines need \(Self.gigabytes(full + Self.diskMargin)) of free disk space "
                        + "(a \(Self.gigabytes(full)) download, then room to unpack it); this Mac has "
                        + "\(Self.gigabytes(free)) free. Free some space, then try again.",
                    fields: ["needBytes": full + Self.diskMargin, "freeBytes": free]))
            return
        }
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        } catch {
            setState(
                .error,
                failure: VoiceFailure(
                    code: "folder-failed",
                    message: "The voice folder \(root.path) cannot be made: \(error.localizedDescription)"))
            return
        }
        _ = openLog()
        do {
            try writeHelper(lock)
        } catch {
            setState(
                .error,
                failure: VoiceFailure(
                    code: "folder-failed", message: "The voice helper cannot be written: \(error.localizedDescription)"))
            return
        }
        let run = Install()
        install = run
        downloadBytes = full
        total = full
        done = pythonReady(lock) ? pythonBytes(lock) : min(Self.fileSize(archivePartial(lock)), lock.pythonSize)
        setState(.installing)
        if pythonReady(lock) {
            startHelperInstall(run, lock)
        } else {
            downloadPython(run, lock)
        }
    }

    private func cancelInstall() {
        guard let run = install else {
            status()
            return
        }
        guard !run.cancelled else { return }
        run.cancelled = true
        if let task = run.task {
            task.cancel()
        } else if let target = run.helperRequest {
            request("cancel", ["target": target]) { _, _ in }
        }
        // While it unpacks, the unpacking finishes and then sees the cancel.
    }

    private func remove() {
        if let run = install {
            run.thenRemove = true
            cancelInstall()
            return
        }
        registrations.removeAll()
        guard helper != nil else {
            removeFiles()
            return
        }
        request("remove", [:]) { [weak self] _, _ in
            self?.stopHelper()
            self?.removeFiles()
        }
    }

    private func removeFiles() {
        for name in Self.installFiles { try? fileManager.removeItem(at: path(name)) }
        try? log?.close()
        log = nil
        // Only if empty: an override may point at a folder with more in it.
        rmdir(root.path)
        if let lock = currentLock() { downloadBytes = fullDownload(lock) }
        setState(.absent)
    }

    /// A voice or speak request for the helper.
    private func relay(_ pageId: Any?, _ op: String, _ fields: [String: Any]) {
        guard let lock = currentLock() else {
            send(["event": "error", "id": pageId ?? NSNull(), "code": "not-installed", "message": message ?? ""])
            return
        }
        guard helper != nil || installComplete(lock) else {
            send([
                "event": "error", "id": pageId ?? NSNull(), "code": "not-installed",
                "message": "Spoken lines are not installed.",
            ])
            return
        }
        guard startHelper(lock) else {
            send(["event": "error", "id": pageId ?? NSNull(), "code": "helper-failed", "message": message ?? ""])
            return
        }
        request(op, fields, pageId: pageId) { [weak self] reply, dropped in
            self?.answer(pageId, op, fields, reply, dropped)
        }
    }

    /// The page's event for the helper's answer to one of its requests.
    private func answer(_ pageId: Any?, _ op: String, _ fields: [String: Any], _ reply: [String: Any], _ dropped: Bool) {
        let id = pageId ?? NSNull()
        if dropped {
            send(["event": "dropped", "id": id])
        } else if reply["ok"] as? Bool == true {
            if op == "voice" {
                let voiceId = reply["voiceId"] as? String ?? ""
                registrations[voiceId] = fields
                send(["event": "voice", "id": id, "voiceId": voiceId])
            } else {
                var event = reply
                event.removeValue(forKey: "ok")
                event["event"] = "speech"
                event["id"] = id
                send(event)
            }
        } else if reply["code"] as? String == "cancelled" {
            send(["event": "dropped", "id": id])
        } else {
            send([
                "event": "error", "id": id, "code": reply["code"] ?? "error",
                "message": reply["error"] ?? "The voice helper failed.",
            ])
        }
    }

    /// The page no longer wants a line: cancel it if it is still queued;
    /// one already running finishes, and either way the page gets
    /// `dropped` for it, once.
    private func drop(_ pageId: Any?) {
        guard let pageId,
            let (target, _) = pending.first(where: { Self.same($0.value.pageId, pageId) && !$0.value.dropped })
        else { return }
        pending[target]?.dropped = true
        request("cancel", ["target": target]) { _, _ in }
    }

    // MARK: the page's status

    /// A state with no failure (absent, installing, ready).
    private func setState(_ next: State) {
        setState(next, failure: nil)
    }

    /// `error` or `unsupported` for `failure`, which the page words by its
    /// code.
    private func setState(_ next: State, failure reason: VoiceFailure?) {
        state = next
        failure = reason
        message = reason?.message
        lastProgress = ProcessInfo.processInfo.systemUptime
        push()
    }

    /// Progress of the install, sent at most four times a second unless
    /// `force`d.
    private func progress(_ value: Int64, force: Bool = false) {
        done = min(value, total)
        let now = ProcessInfo.processInfo.systemUptime
        guard force || done == total || now - lastProgress >= 0.25 else { return }
        lastProgress = now
        push()
    }

    private func push() {
        guard let state else { return }
        var event: [String: Any] = ["event": "status", "state": state.rawValue, "downloadBytes": downloadBytes]
        if state == .installing {
            event["done"] = done
            event["total"] = total
        }
        if state == .error || state == .unsupported {
            if let message { event["message"] = message }
            if let failure {
                event["code"] = failure.code
                event.merge(failure.fields) { _, field in field }
            }
        }
        send(event)
    }

    private func send(_ event: [String: Any]) {
        DispatchQueue.main.async { self.deliver?(event) }
    }

    // MARK: the lock and the folder

    private func loadLock() -> Result<Lock, VoiceFailure> {
        let data: Data?
        if let file = settings.lockFile {
            data = try? Data(contentsOf: URL(fileURLWithPath: file))
        } else {
            data = KineticVoiceEmbedded.files.first { $0.path == KineticVoiceEmbedded.lockPath }
                .flatMap { Data(base64Encoded: $0.base64) }
        }
        guard let data else { return .failure(VoiceFailure(code: "lock-failed", message: "The voice lock file is missing.")) }
        do {
            return .success(try Lock(data, downloadBase: settings.downloadBase))
        } catch let failure as VoiceFailure {
            return .failure(failure)
        } catch {
            return .failure(
                VoiceFailure(
                    code: "lock-failed", message: "The voice lock file is not readable: \(error.localizedDescription)"))
        }
    }

    private func currentLock() -> Lock? {
        switch lockLoad {
        case .success(let lock): return lock
        case .failure(let failure):
            setState(.error, failure: failure)
            return nil
        }
    }

    private func unsupported(_ lock: Lock) -> VoiceFailure? {
        #if arch(arm64)
            if case .failure(let failure) = lock.wheels(for: ProcessInfo.processInfo.operatingSystemVersion) {
                return failure
            }
            return nil
        #else
            return VoiceFailure(code: "apple-silicon", message: "Spoken lines need a Mac with Apple silicon.")
        #endif
    }

    /// The Python download's size, or 0 when the tests supply a Python.
    private func pythonBytes(_ lock: Lock) -> Int64 {
        settings.python == nil && settings.helperCommand == nil ? lock.pythonSize : 0
    }

    /// The whole install's download: Python and the helper's share.
    private func fullDownload(_ lock: Lock) -> Int64 {
        pythonBytes(lock) + (lock.helperBytes(for: ProcessInfo.processInfo.operatingSystemVersion) ?? 0)
    }

    private func pythonExecutable() -> URL {
        settings.python.map { URL(fileURLWithPath: $0) }
            ?? path("python").appendingPathComponent("bin").appendingPathComponent("python3")
    }

    private func pythonReady(_ lock: Lock) -> Bool {
        if settings.python != nil || settings.helperCommand != nil { return true }
        let marker = path("python").appendingPathComponent(Self.pythonMarker)
        return fileManager.isExecutableFile(atPath: pythonExecutable().path)
            && (try? String(contentsOf: marker, encoding: .utf8)) == lock.pythonSHA256
    }

    /// Python is there and the helper has finished an install of this lock
    /// (its state.json), so the helper may start for a status or a line.
    private func installComplete(_ lock: Lock) -> Bool {
        if settings.helperCommand != nil { return true }
        guard pythonReady(lock), let data = try? Data(contentsOf: path("state.json")),
            let installed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return false }
        return installed["lock"] as? String == lock.id
    }

    /// Free space on the voice folder's volume (asked of its nearest
    /// existing folder, so a refused install makes no folder).
    private func freeBytes() -> Int64? {
        var dir = root
        while !fileManager.fileExists(atPath: dir.path), dir.path != "/" { dir.deleteLastPathComponent() }
        let values = try? dir.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    /// The helper's files into `helper/`, each only when absent or
    /// different, atomically; a file a newer app dropped is removed.
    private func writeHelper(_ lock: Lock) throws {
        let dir = path("helper")
        var wanted: Set<String> = []
        for file in KineticVoiceEmbedded.files {
            let data =
                file.path == KineticVoiceEmbedded.lockPath ? lock.helperText : Data(base64Encoded: file.base64) ?? Data()
            let target = dir.appendingPathComponent(file.path)
            wanted.insert(target.standardizedFileURL.path)
            if (try? Data(contentsOf: target)) == data { continue }
            try fileManager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target, options: .atomic)
        }
        let package = dir.appendingPathComponent("kinetic_voice")
        for name in (try? fileManager.contentsOfDirectory(atPath: package.path)) ?? [] where name.hasSuffix(".py") {
            let file = package.appendingPathComponent(name)
            if !wanted.contains(file.standardizedFileURL.path) { try? fileManager.removeItem(at: file) }
        }
    }

    // MARK: the Python download

    private func archivePartial(_ lock: Lock) -> URL {
        path("downloads").appendingPathComponent("python-\(lock.pythonSHA256.prefix(12)).tar.gz.partial")
    }

    private func downloadPython(_ run: Install, _ lock: Lock) {
        let partial = archivePartial(lock)
        try? fileManager.createDirectory(at: partial.deletingLastPathComponent(), withIntermediateDirectories: true)
        var have = Self.fileSize(partial)
        if have > lock.pythonSize {
            try? fileManager.removeItem(at: partial)
            have = 0
        }
        run.have = have
        if have == lock.pythonSize {
            unpackPython(run, lock)
            return
        }
        guard let url = URL(string: lock.pythonURL) else {
            failInstall(VoiceFailure(code: "install-failed", message: "The Python download's address is not valid."))
            return
        }
        var request = URLRequest(url: url)
        request.setValue("kinetic-voice", forHTTPHeaderField: "User-Agent")
        // Resume: the rest of a partial file from an earlier run.
        if have > 0 { request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range") }
        let task = session.dataTask(with: request)
        run.task = task
        logLine("downloading Python from \(url.absoluteString)" + (have > 0 ? " from byte \(have)" : ""))
        task.resume()
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let run = install, run.task === dataTask, case .success(let lock) = lockLoad else {
            completionHandler(.cancel)
            return
        }
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        let partial = archivePartial(lock)
        do {
            if code == 206, run.have > 0 {
                let file = try FileHandle(forWritingTo: partial)
                try file.seekToEnd()
                run.file = file
            } else if code == 200 {
                // The whole file: start again.
                fileManager.createFile(atPath: partial.path, contents: nil)
                run.file = try FileHandle(forWritingTo: partial)
                run.have = 0
            } else {
                run.failure = VoiceFailure(code: "download-failed", message: "The Python download failed (HTTP \(code)).")
                completionHandler(.cancel)
                return
            }
        } catch {
            run.failure = VoiceFailure(
                code: "folder-failed", message: "The Python download cannot be saved: \(error.localizedDescription)")
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let run = install, run.task === dataTask, let file = run.file else { return }
        do {
            try file.write(contentsOf: data)
        } catch {
            run.failure = VoiceFailure(
                code: "folder-failed", message: "The Python download cannot be saved: \(error.localizedDescription)")
            dataTask.cancel()
            return
        }
        run.have += Int64(data.count)
        progress(run.have)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let run = install, run.task === task, case .success(let lock) = lockLoad else { return }
        try? run.file?.close()
        run.file = nil
        run.task = nil
        if run.cancelled {
            logLine("Python download cancelled at byte \(run.have)")
            finishCancelled(run)
        } else if let failure = run.failure {
            failInstall(failure)
        } else if let error {
            failInstall(
                VoiceFailure(
                    code: "download-failed",
                    message: "The Python download failed: \(error.localizedDescription). Try again to continue it."))
        } else if run.have != lock.pythonSize {
            failInstall(
                VoiceFailure(
                    code: "download-failed",
                    message:
                        "The Python download stopped at \(run.have) of \(lock.pythonSize) bytes. Try again to continue it."
                ))
        } else {
            unpackPython(run, lock)
        }
    }

    /// Checks the archive's sha256 and unpacks it into `python/`, away from
    /// the queue.
    private func unpackPython(_ run: Install, _ lock: Lock) {
        progress(lock.pythonSize, force: true)
        let archive = archivePartial(lock)
        let root = self.root
        DispatchQueue.global(qos: .utility).async {
            let result = Self.unpack(archive: archive, sha256: lock.pythonSHA256, root: root)
            self.queue.async {
                guard self.install === run else { return }
                switch result {
                case .failure(let failure): self.failInstall(failure)
                case .success:
                    self.logLine("Python unpacked into \(root.appendingPathComponent("python").path)")
                    if run.cancelled { self.finishCancelled(run) } else { self.startHelperInstall(run, lock) }
                }
            }
        }
    }

    static func unpack(archive: URL, sha256: String, root: URL) -> Result<Void, VoiceFailure> {
        let fileManager = FileManager.default
        guard let digest = sha256Hex(of: archive) else {
            return .failure(VoiceFailure(code: "install-failed", message: "The Python download cannot be read."))
        }
        guard digest == sha256 else {
            try? fileManager.removeItem(at: archive)
            return .failure(
                VoiceFailure(
                    code: "hash-mismatch",
                    message: "The Python download did not match its checksum, so it was deleted. Try again."))
        }
        let staging = root.appendingPathComponent("python.partial")
        try? fileManager.removeItem(at: staging)
        do {
            try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
            let tar = Process()
            tar.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            tar.arguments = ["-xzf", archive.path, "-C", staging.path]
            tar.standardOutput = FileHandle.nullDevice
            tar.standardError = FileHandle.nullDevice
            try tar.run()
            tar.waitUntilExit()
            guard tar.terminationStatus == 0 else {
                throw VoiceFailure(
                    code: "install-failed",
                    message: "The Python download could not be unpacked (tar exit \(tar.terminationStatus)).")
            }
            // python-build-standalone's install_only archives hold python/.
            let unpacked = staging.appendingPathComponent("python")
            guard fileManager.isExecutableFile(atPath: unpacked.appendingPathComponent("bin/python3").path) else {
                throw VoiceFailure(code: "install-failed", message: "The Python download holds no python/bin/python3.")
            }
            try Data(sha256.utf8).write(to: unpacked.appendingPathComponent(pythonMarker), options: .atomic)
            let target = root.appendingPathComponent("python")
            try? fileManager.removeItem(at: target)
            try fileManager.moveItem(at: unpacked, to: target)
            try? fileManager.removeItem(at: staging)
            try? fileManager.removeItem(at: archive)
            // downloads/ is the helper's too: left only if it holds more.
            rmdir(archive.deletingLastPathComponent().path)
            return .success(())
        } catch let failure as VoiceFailure {
            try? fileManager.removeItem(at: staging)
            return .failure(failure)
        } catch {
            try? fileManager.removeItem(at: staging)
            return .failure(
                VoiceFailure(code: "install-failed", message: "Python could not be unpacked: \(error.localizedDescription)"))
        }
    }

    static func sha256Hex(of url: URL) -> String? {
        guard let file = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? file.close() }
        var hasher = SHA256()
        while let chunk = try? file.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: the helper's install

    private func startHelperInstall(_ run: Install, _ lock: Lock) {
        guard startHelper(lock) else {
            install = nil
            return
        }
        let base = pythonBytes(lock)
        progress(base, force: true)
        run.helperRequest = request("install", [:]) { [weak self] reply, _ in
            self?.installAnswered(run, reply)
        }
    }

    /// A helper progress event: on the install's scale, after Python.
    private func helperProgress(_ event: [String: Any]) {
        guard install?.helperRequest != nil, case .success(let lock) = lockLoad,
            let value = Self.int64(event["done"]), let whole = Self.int64(event["total"])
        else { return }
        let base = pythonBytes(lock)
        total = base + whole
        progress(base + value)
    }

    private func installAnswered(_ run: Install, _ reply: [String: Any]) {
        guard install === run else { return }
        install = nil
        let code = reply["code"] as? String
        if reply["ok"] as? Bool == true {
            setState(.ready)
        } else if code == "cancelled" {
            finishCancelled(run)
            return
        } else if code == "unsupported-system" {
            setState(
                .unsupported,
                failure: VoiceFailure(
                    code: "unsupported-system", message: "Spoken lines need a newer macOS (\(reply["error"] ?? ""))."))
        } else {
            // The helper's code is the page's (apps/voice/README.md).
            let detail = reply["error"] as? String ?? "unknown error"
            let failure: VoiceFailure
            switch code {
            case "download-failed":
                failure = VoiceFailure(code: "download-failed", message: "A download failed (\(detail)). Try again to continue it.")
            case "hash-mismatch":
                failure = VoiceFailure(
                    code: "hash-mismatch", message: "A download did not match its checksum (\(detail)). Try again.")
            case "pip-failed":
                failure = VoiceFailure(code: "pip-failed", message: "Installing the voice packages failed (\(detail)).")
            default:
                failure = VoiceFailure(code: "install-failed", message: "The voice install failed (\(detail)).")
            }
            setState(.error, failure: failure)
        }
        if run.thenRemove { remove() }
    }

    private func finishCancelled(_ run: Install) {
        install = nil
        if let lock = currentLock() { downloadBytes = fullDownload(lock) }
        setState(.absent)
        if run.thenRemove { remove() }
    }

    private func failInstall(_ failure: VoiceFailure) {
        let run = install
        install = nil
        logLine("install failed: \(failure.message)")
        setState(.error, failure: failure)
        if run?.thenRemove == true { remove() }
    }

    // MARK: the helper process

    /// Starts the helper unless it runs; false (with the error state set)
    /// when it cannot start.
    private func startHelper(_ lock: Lock) -> Bool {
        if helper != nil { return true }
        do {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
            try writeHelper(lock)
            helper = try launchHelper()
            return true
        } catch {
            let text = (error as? VoiceFailure)?.message ?? error.localizedDescription
            setState(.error, failure: VoiceFailure(code: "helper-failed", message: "The voice helper could not start: \(text)"))
            return false
        }
    }

    private func launchHelper() throws -> Helper {
        let process = Process()
        if let command = settings.helperCommand {
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", "exec \(command)"]
        } else {
            process.executableURL = pythonExecutable()
            let main = path("helper").appendingPathComponent("kinetic_voice").appendingPathComponent("__main__.py")
            process.arguments = ["-I", "-B", main.path, "--root", root.path]
        }
        // The real helper runs in the voice folder; a test command runs
        // where the app was started, so its relative paths mean what they
        // meant there.
        process.currentDirectoryURL =
            settings.helperCommand == nil
            ? root : URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        process.standardError = openLog()
        try process.run()
        let helper = Helper(process: process, input: input.fileHandleForWriting)
        logLine("helper started (pid \(process.processIdentifier))")
        let reader = output.fileHandleForReading
        // One line a message; the thread ends when the helper's stdout
        // does, then reports its exit after its last line. (A plain read:
        // FileHandle's read(upToCount:) waits for the whole count.)
        Thread.detachNewThread { [weak self] in
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 1 << 16)
            while true {
                let got = read(reader.fileDescriptor, &chunk, chunk.count)
                if got < 0, errno == EINTR { continue }
                if got <= 0 { break }
                var scanFrom = buffer.count
                buffer.append(contentsOf: chunk[0..<got])
                while let newline = buffer[scanFrom...].firstIndex(of: 0x0A) {
                    let line = buffer.subdata(in: 0..<newline)
                    buffer = buffer.subdata(in: (newline + 1)..<buffer.count)
                    scanFrom = 0
                    guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
                        continue
                    }
                    self?.queue.async { self?.helperSaid(message, helper) }
                }
            }
            process.waitUntilExit()
            let status = process.terminationStatus
            self?.queue.async { self?.helperExited(helper, status) }
        }
        return helper
    }

    /// helper.log, kept under the limit: the helper's stderr and the app's
    /// own lines about it.
    private func openLog() -> FileHandle {
        if let log { return log }
        let file = path("helper.log")
        let size = (try? fileManager.attributesOfItem(atPath: file.path)[.size] as? UInt64) ?? 0
        let flags = O_WRONLY | O_CREAT | O_APPEND | (size > Self.helperLogLimit ? O_TRUNC : 0)
        let fd = open(file.path, flags, 0o644)
        let handle = fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : FileHandle.nullDevice
        log = handle
        return handle
    }

    private func logLine(_ text: String) {
        guard let log else { return }
        let stamp = ISO8601DateFormatter().string(from: Date())
        try? log.write(contentsOf: Data("[app \(stamp)] \(text)\n".utf8))
    }

    /// Sends one request; returns its id. `reply` gets the answer.
    @discardableResult
    private func request(
        _ op: String, _ fields: [String: Any], pageId: Any? = nil, reply: @escaping ([String: Any], Bool) -> Void
    ) -> Int {
        let id = nextRequest
        nextRequest += 1
        var message = fields
        message["op"] = op
        pending[id] = Pending(request: message, pageId: pageId, reply: reply)
        write(id, message)
        return id
    }

    private func write(_ id: Int, _ message: [String: Any]) {
        guard let helper else { return }
        var line = message
        line["id"] = id
        guard JSONSerialization.isValidJSONObject(line),
            var data = try? JSONSerialization.data(withJSONObject: line, options: [.withoutEscapingSlashes])
        else {
            pending.removeValue(forKey: id)?.reply(
                ["id": id, "ok": false, "code": "bad-request", "error": "the request is not JSON"], false)
            return
        }
        data.append(0x0A)
        // A helper that has just died fails the write; its exit follows.
        try? helper.input.write(contentsOf: data)
    }

    private func helperSaid(_ message: [String: Any], _ from: Helper) {
        guard helper === from else { return }
        if let event = message["event"] as? String {
            switch event {
            case "progress":
                helperProgress(message)
            case "log":
                logLine("helper: \(Self.json(message))")
            default:
                // Events about a request (a streamed line's chunks, say)
                // go to the page under the page's id.
                guard let target = Self.int(message["target"]), let entry = pending[target], let pageId = entry.pageId
                else {
                    logLine("helper: \(Self.json(message))")
                    return
                }
                if entry.dropped { return }
                var forward = message
                forward.removeValue(forKey: "target")
                forward["id"] = pageId
                send(forward)
            }
            return
        }
        guard let id = Self.int(message["id"]), let entry = pending.removeValue(forKey: id) else {
            logLine("helper answered no request: \(Self.json(message))")
            return
        }
        entry.reply(message, entry.dropped)
    }

    private func stopHelper() {
        guard let helper else { return }
        helper.stopping = true
        try? helper.input.close()
        helper.process.terminate()
    }

    private func helperExited(_ gone: Helper, _ status: Int32) {
        guard helper === gone else { return }
        helper = nil
        if gone.stopping {
            logLine("helper stopped (status \(status))")
            failPending("helper-stopped", "The voice helper was stopped.")
            return
        }
        crashes += 1
        logLine("helper exited unexpectedly (status \(status)); crash \(crashes)")
        if crashes == 1, case .success(let lock) = lockLoad, startHelper(lock) {
            // Once: the voices again, then every request still unanswered,
            // under its own id.
            let unanswered = pending.sorted { $0.key < $1.key }
            for registration in registrations.values { request("voice", registration) { _, _ in } }
            for (id, entry) in unanswered { write(id, entry.request) }
            return
        }
        let run = install
        install = nil
        let text = "The voice helper stopped unexpectedly. Its log is \(path("helper.log").path)."
        failPending("helper-crashed", text)
        setState(.error, failure: VoiceFailure(code: "helper-crashed", message: text))
        if run?.thenRemove == true { remove() }
    }

    /// Answers every unanswered request with a failure.
    private func failPending(_ code: String, _ text: String) {
        let all = pending.sorted { $0.key < $1.key }
        pending.removeAll()
        for (id, entry) in all { entry.reply(["id": id, "ok": false, "code": code, "error": text], entry.dropped) }
    }

    // MARK: small helpers

    static func int64(_ value: Any?) -> Int64? { (value as? NSNumber)?.int64Value }
    static func int(_ value: Any?) -> Int? { (value as? NSNumber)?.intValue }

    static func same(_ a: Any?, _ b: Any) -> Bool {
        guard let a = a as? NSObject else { return false }
        return a.isEqual(b)
    }

    static func version(_ text: String) -> [Int] {
        var parts = text.split(separator: ".").map { Int($0) ?? 0 }
        while parts.count < 3 { parts.append(0) }
        return Array(parts.prefix(3))
    }

    static func fileSize(_ url: URL) -> Int64 {
        ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.int64Value ?? 0
    }

    static func gigabytes(_ bytes: Int64) -> String {
        String(format: "%.1f GB", Double(bytes) / 1e9)
    }

    static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else {
            return "\(value)"
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// `url` with its scheme and host moved under `base`
    /// (`https://host/path` to `<base>/host/path`), when a base is set.
    static func redirect(_ url: String, to base: String?) -> String {
        guard let base, let range = url.range(of: "://") else { return url }
        let trimmed = base.hasSuffix("/") ? String(base.dropLast()) : base
        return trimmed + "/" + url[range.upperBound...]
    }
}
