// webkit/prebuilt.mjs: the installed check-game's driver lookup.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DRIVER_NAME, DriverBuildError, ensureDriver } from "./prebuilt.mjs";

describe("ensureDriver (prebuilt)", () => {
  it("returns the driver beside the bundle on macOS", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-prebuilt-"));
    try {
      writeFileSync(join(dir, DRIVER_NAME), "");
      expect(ensureDriver(dir, "darwin")).toBe(join(dir, DRIVER_NAME));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says there is no driver when none is there", () => {
    const dir = mkdtempSync(join(tmpdir(), "kinetic-prebuilt-"));
    try {
      expect(() => ensureDriver(dir, "darwin")).toThrow(DriverBuildError);
      expect(() => ensureDriver(dir, "darwin")).toThrow(/no prebuilt WebKit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("needs macOS", () => {
    expect(() => ensureDriver(tmpdir(), "linux")).toThrow(/needs macOS/);
  });
});
