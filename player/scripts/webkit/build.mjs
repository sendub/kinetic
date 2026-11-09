// Builds the WebKit driver (apps/macos/driver) on first use, into
// .tmp/webkit-driver-build/<hash>/kinetic-webkit-driver, ad-hoc signed. The
// hash covers the Swift sources and the build flags, so an edit rebuilds and
// an unchanged checkout reuses the last build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const SOURCES = [
  join(repoRoot, "apps", "macos", "WebViewSetup.swift"),
  join(repoRoot, "apps", "macos", "driver", "main.swift"),
];
const buildRoot = join(repoRoot, ".tmp", "webkit-driver-build");
const NAME = "kinetic-webkit-driver";
const NEEDS =
  "The WebKit engine needs macOS with a Swift toolchain: Xcode or the Command Line Tools (xcode-select --install).";

/** A missing toolchain or a failed build, said plainly. */
export class DriverBuildError extends Error {}

/** The swiftc flags; the app's minimum macOS, so this build proves it too. */
function flags() {
  const cpu = arch() === "arm64" ? "arm64" : "x86_64";
  return ["-O", "-target", `${cpu}-apple-macos12`];
}

/** Path to a built, signed driver for the current sources (built if need be). */
export function ensureDriver() {
  if (platform() !== "darwin") throw new DriverBuildError(NEEDS);
  const hash = createHash("sha256");
  hash.update(flags().join(" "));
  for (const file of SOURCES) {
    hash.update(`\0${relative(repoRoot, file)}\0`);
    hash.update(readFileSync(file));
  }
  const dir = join(buildRoot, hash.digest("hex").slice(0, 16));
  const binary = join(dir, NAME);
  if (existsSync(binary)) return binary;

  // `xcode-select -p` fails quietly without developer tools, where calling
  // the /usr/bin/swiftc stub would pop up the installer instead.
  const run = (cmd, args) =>
    execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    run("xcode-select", ["-p"]);
    run("xcrun", ["--find", "swiftc"]);
  } catch {
    throw new DriverBuildError(NEEDS);
  }
  // Built beside the final folder, then renamed into place, so runs that
  // build at the same moment never see half a binary.
  const partial = `${dir}.partial-${process.pid}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  try {
    // Through xcrun, which hands swiftc the macOS SDK.
    run("xcrun", [
      "--sdk",
      "macosx",
      "swiftc",
      ...flags(),
      "-module-cache-path",
      join(buildRoot, "module-cache"),
      "-o",
      join(partial, NAME),
      ...SOURCES,
    ]);
    run("codesign", ["--force", "--sign", "-", join(partial, NAME)]);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw new DriverBuildError(
      `Building the WebKit driver failed:\n${error.stderr || error.message}`,
    );
  }
  try {
    renameSync(partial, dir);
  } catch {
    // Another run finished the same build first; use that one.
    rmSync(partial, { recursive: true, force: true });
  }
  return binary;
}
