// The game's settings (docs/plan.md Phase 57 item 10). The app's binary is
// built once per Kinetic release with none; `kinetic apps --mac` copies it
// into a game folder's `<title>.app` and writes the game's settings into
// the bundle's Info.plist, beside the bundle id `org.kinetic.game.<storyId>`
// (under which macOS keeps the reader's progress):
//
//   KineticStoryId     the manifest's storyId
//   KineticTitle       the manifest's title, for the menus and the window
//   KineticWindowSize  {Width, Height}: the first graphic's pixel size,
//                      for the first window (absent without a picture)
//   KineticVersion     the Kinetic that made the app
//
// macOS reads Info.plist anyway when the app starts; the app reads these
// keys from it once (main.swift) and holds them.
//
// `<binary> --self-check FILE` writes the settings it read to FILE as JSON
// and exits before the app starts, so no window or Dock icon appears;
// tools and tests read the file. Foundation only, so the tests
// (apps/macos/tests/) compile it on its own.

import Foundation

struct HostSettings {
    var storyId: String
    /// The game's name: KineticTitle, else CFBundleName, else "Kinetic".
    var title: String
    /// The first window's content size; nil for 16:9.
    var windowSize: CGSize?
    var kineticVersion: String
    var bundleId: String

    /// The settings in an Info.plist dictionary (Bundle.main.infoDictionary).
    init(info: [String: Any]) {
        func text(_ key: String) -> String? {
            (info[key] as? String).flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        }
        storyId = text("KineticStoryId") ?? ""
        title = text("KineticTitle") ?? text("CFBundleName") ?? "Kinetic"
        kineticVersion = text("KineticVersion") ?? ""
        bundleId = text("CFBundleIdentifier") ?? ""
        let size = info["KineticWindowSize"] as? [String: Any]
        let width = (size?["Width"] as? NSNumber)?.doubleValue ?? 0
        let height = (size?["Height"] as? NSNumber)?.doubleValue ?? 0
        windowSize = width >= 1 && height >= 1 ? CGSize(width: width, height: height) : nil
    }

    /// The first window's content size: the first graphic's, else 16:9 at
    /// 1280 x 720.
    var firstContentSize: CGSize { windowSize ?? CGSize(width: 1280, height: 720) }

    /// What --self-check writes: the keys the Windows exe writes
    /// (apps/windows/settings.go), with the bundle id besides; sorted, the
    /// window size null when there is none.
    func selfCheckJSON() -> Data {
        let size: Any = windowSize.map { ["width": Int($0.width), "height": Int($0.height)] } ?? NSNull()
        let report: [String: Any] = [
            "host": "macos", "storyId": storyId, "title": title, "windowSize": size,
            "kineticVersion": kineticVersion, "bundleId": bundleId,
        ]
        let data = (try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])) ?? Data("{}".utf8)
        return data + Data("\n".utf8)
    }

    /// Writes the --self-check report to `path`; the exit code: 0 written,
    /// 1 not written, 2 no FILE given.
    func selfCheck(to path: String) -> Int32 {
        if path.isEmpty { return 2 }
        do {
            try selfCheckJSON().write(to: URL(fileURLWithPath: path))
            return 0
        } catch {
            return 1
        }
    }
}

/// `--self-check FILE`'s FILE among the arguments (after the program's
/// name); "" when FILE is missing, nil without the flag.
func selfCheckPath(_ arguments: [String]) -> String? {
    for (index, argument) in arguments.enumerated() {
        if argument == "--self-check" {
            return index + 1 < arguments.count ? arguments[index + 1] : ""
        }
        if argument.hasPrefix("--self-check=") {
            return String(argument.dropFirst("--self-check=".count))
        }
    }
    return nil
}
