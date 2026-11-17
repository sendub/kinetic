// The WebKit driver of the check-game an installed Kinetic carries
// (scripts/bundle-check.mjs puts this module where webkit/build.mjs was).
// An install has no Swift sources to build the driver from, so it uses the
// driver binary the release built and placed beside the bundle
// (`bundle-check.mjs --driver`, which tools/build_wheel.py runs;
// docs/plan.md Phase 57, item 10); without one, the engine "auto" tests on
// Chrome and says why (testing/kinetic.mjs chooseEngine), and asking for
// "webkit" fails with that reason.
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A missing driver, said plainly (webkit/build.mjs has the same class). */
export class DriverBuildError extends Error {}

/** The driver binary's name beside the bundle. */
export const DRIVER_NAME = "kinetic-webkit-driver";

/**
 * Path to the prebuilt driver in `dir` (default: the bundle's folder);
 * throws DriverBuildError off macOS or when there is none.
 */
export function ensureDriver(
  dir = dirname(fileURLToPath(import.meta.url)),
  system = platform(),
) {
  if (system !== "darwin") {
    throw new DriverBuildError("The WebKit engine needs macOS.");
  }
  const driver = join(dir, DRIVER_NAME);
  if (!existsSync(driver)) {
    throw new DriverBuildError(
      `This Kinetic install has no prebuilt WebKit driver (${driver}).`,
    );
  }
  return driver;
}
