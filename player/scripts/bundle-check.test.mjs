// scripts/bundle-check.mjs: the testing library an installed Kinetic
// carries, one module with puppeteer-core inside, and check-game built on
// it, so puppeteer-core is in the wheel once (docs/plan.md Phase 58, item
// 4). Both run from a folder with no node_modules anywhere above it.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleCheck } from "./bundle-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const version = readFileSync(resolve(here, "../../VERSION"), "utf8").trim();
const scratch = resolve(here, "../../.tmp");
let out;
let away;

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  out = mkdtempSync(join(scratch, "bundle-check-test-"));
  await bundleCheck(out);
  // A copy outside the repo: no player/node_modules to fall back on.
  away = mkdtempSync(join(tmpdir(), "kinetic-bundle-check-"));
  cpSync(out, away, { recursive: true });
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
  if (away) rmSync(away, { recursive: true, force: true });
});

describe("bundle-check", () => {
  it("writes the library, check-game and the Node it needs", () => {
    expect(readdirSync(out).sort()).toEqual([
      "check-game.json",
      "check-game.mjs",
      "kinetic.mjs",
    ]);
    const needs = JSON.parse(readFileSync(join(out, "check-game.json")));
    expect(needs.kinetic).toBe(version);
    expect(needs.node).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("puts puppeteer-core in the library alone, check-game importing it", () => {
    const library = readFileSync(join(out, "kinetic.mjs"), "utf8");
    const check = readFileSync(join(out, "check-game.mjs"), "utf8");
    expect(library).toContain("node_modules/puppeteer-core/");
    expect(check).not.toContain("puppeteer");
    expect(check).toContain('from "./kinetic.mjs"');
    expect(check.length).toBeLessThan(library.length / 20);
  });

  it("builds in the version, the prebuilt driver and the per-user scratch", () => {
    const library = readFileSync(join(out, "kinetic.mjs"), "utf8");
    expect(library).toContain(
      `var KINETIC_VERSION = ${JSON.stringify(version)};`,
    );
    expect(library).toContain("var INSTALLED = true;");
    expect(library).toContain("no prebuilt WebKit driver");
    expect(library).not.toContain("swiftc");
  });

  it("imports and runs with plain node and no node_modules", () => {
    const exported = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const m = await import(process.argv[1]); console.log(Object.keys(m).join(' '));",
        join(away, "kinetic.mjs"),
      ],
      { cwd: away, encoding: "utf8" },
    ).split(" ");
    for (const name of ["openGame", "readManifestFile", "summary"]) {
      expect(exported.map((n) => n.trim())).toContain(name);
    }
    const said = execFileSync(
      process.execPath,
      [join(away, "check-game.mjs"), "--version"],
      { cwd: away, encoding: "utf8" },
    );
    expect(said).toBe(`Kinetic ${version}\n`);
  });
});
