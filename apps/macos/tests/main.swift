// Tests for ../app/HostSettings.swift: the settings the game app reads from
// its Info.plist and its --self-check report. tools/test_build_apps.py
// compiles this file with HostSettings.swift alone (no AppKit, no window)
// and runs it; it prints each failure and exits 1 if any.

import CoreGraphics
import Foundation

var failures = 0

func expect(_ condition: Bool, _ message: @autoclosure () -> String, line: Int = #line) {
    if !condition {
        failures += 1
        print("FAIL line \(line): \(message())")
    }
}

func report(_ settings: HostSettings) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: settings.selfCheckJSON())) as? [String: Any] ?? [:]
}

// Every key `kinetic apps` writes.
let full = HostSettings(info: [
    "CFBundleIdentifier": "org.kinetic.game.rainy-day-2",
    "CFBundleName": "Rainy Day",
    "KineticStoryId": "rainy_day-2",
    "KineticTitle": "Zoë's \"Day\" 100%",
    "KineticVersion": "1.12.0",
    "KineticWindowSize": ["Width": 1920, "Height": 1080],
])
expect(full.storyId == "rainy_day-2", "storyId \(full.storyId)")
expect(full.title == "Zoë's \"Day\" 100%", "title \(full.title)")
expect(full.kineticVersion == "1.12.0", "version \(full.kineticVersion)")
expect(full.bundleId == "org.kinetic.game.rainy-day-2", "bundle id \(full.bundleId)")
expect(full.windowSize == CGSize(width: 1920, height: 1080), "size \(String(describing: full.windowSize))")
expect(full.firstContentSize == CGSize(width: 1920, height: 1080), "first content")

let fullReport = report(full)
expect(Set(fullReport.keys) == ["host", "storyId", "title", "windowSize", "kineticVersion", "bundleId"],
       "report keys \(fullReport.keys.sorted())")
expect(fullReport["host"] as? String == "macos", "host")
expect(fullReport["title"] as? String == "Zoë's \"Day\" 100%", "report title")
let size = fullReport["windowSize"] as? [String: Int]
expect(size == ["width": 1920, "height": 1080], "report size \(String(describing: size))")

// No title: the bundle name; no size, or a size below 1 x 1: 16:9.
let plain = HostSettings(info: ["CFBundleName": "Rainy", "KineticWindowSize": ["Width": 0, "Height": 5]])
expect(plain.title == "Rainy", "title from the bundle name: \(plain.title)")
expect(plain.windowSize == nil, "a 0-wide size is none")
expect(plain.firstContentSize == CGSize(width: 1280, height: 720), "16:9")
expect(report(plain)["windowSize"] is NSNull, "no size is null in the report")

// The binary as each release builds it, before a game: nothing set.
let empty = HostSettings(info: [:])
expect(empty.storyId == "" && empty.title == "Kinetic" && empty.kineticVersion == "", "empty settings")
expect(HostSettings(info: ["KineticTitle": "  ", "CFBundleName": "Named"]).title == "Named", "a blank title")
expect(HostSettings(info: ["KineticWindowSize": ["Width": 64.0, "Height": 48.0]]).windowSize
       == CGSize(width: 64, height: 48), "a size in reals")

// The flag.
expect(selfCheckPath([]) == nil, "no flag")
expect(selfCheckPath(["-NSDocumentRevisionsDebugMode", "YES"]) == nil, "other arguments")
expect(selfCheckPath(["--self-check", "/tmp/a b.json"]) == "/tmp/a b.json", "flag and file")
expect(selfCheckPath(["--self-check=out.json"]) == "out.json", "flag=file")
expect(selfCheckPath(["--self-check"]) == "", "flag without a file")

// Writing the report.
let dir = FileManager.default.temporaryDirectory.appendingPathComponent("host-settings-\(getpid())")
try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
let out = dir.appendingPathComponent("out.json")
expect(full.selfCheck(to: out.path) == 0, "written")
expect((try? Data(contentsOf: out)) == full.selfCheckJSON(), "the file holds the report")
expect(full.selfCheck(to: "") == 2, "no file is 2")
expect(full.selfCheck(to: dir.appendingPathComponent("missing/out.json").path) == 1, "an unwritable file is 1")
try? FileManager.default.removeItem(at: dir)

if failures > 0 {
    print("\(failures) failed")
    exit(1)
}
print("HostSettings tests passed")
