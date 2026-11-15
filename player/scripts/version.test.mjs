// Kinetic's version and app.js's stamp (version.mjs; docs/plan.md Phase
// 51, item 2): the VERSION file, the stamp line written and read back on
// stamped and unstamped app.js text, and a folder's player version read
// from its app.js on disk. The converter reads the same stamp
// (converter/tests/test_version.py).
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  folderKineticVersion,
  KINETIC_VERSION,
  readStamp,
  readVersionFile,
  stampLine,
  VERSION_DEFINE,
} from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const versionFile = readFileSync(resolve(here, "../../VERSION"), "utf8");
const license = readFileSync(resolve(here, "../../LICENSE"), "utf8");
const IIFE = '"use strict";\n(() => {\n})();\n';
const scratch = resolve(here, "../../.tmp");
mkdirSync(scratch, { recursive: true });
const temp = mkdtempSync(join(scratch, "version-test-"));

afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** A VERSION file holding `text`, as a file URL. */
const versionAt = (name, text) => {
  const file = join(temp, name);
  writeFileSync(file, text);
  return pathToFileURL(file);
};

describe("KINETIC_VERSION", () => {
  it("is the repo's VERSION file, its newline dropped", () => {
    expect(KINETIC_VERSION).toBe(versionFile.trim());
    expect(VERSION_DEFINE).toEqual({
      __KINETIC_VERSION__: JSON.stringify(versionFile.trim()),
    });
  });

  it("refuses a VERSION file that is not one line in the release or -dev form", () => {
    expect(readVersionFile(versionAt("ok", "2.0.0\n"))).toBe("2.0.0");
    expect(readVersionFile(versionAt("dev", "2.1.0-dev"))).toBe("2.1.0-dev");
    for (const text of ["", "2.0\n", "2.0.0\n\n", "v2.0.0\n", "2.0.0-rc1\n"]) {
      expect(
        () => readVersionFile(versionAt("bad", text)),
        JSON.stringify(text),
      ).toThrow(/VERSION must be one line/);
    }
  });
});

describe("the stamp", () => {
  it("is app.js's first line, read back as written", () => {
    expect(stampLine("1.8.0-dev")).toBe("/*! Kinetic 1.8.0-dev */");
    expect(readStamp(`${stampLine("1.8.0-dev")}\n/*!\n${license}*/\n`)).toBe(
      "1.8.0-dev",
    );
    expect(readStamp(`${stampLine("2.0.0-rc.1+b5")}\n${IIFE}`)).toBe(
      "2.0.0-rc.1+b5",
    );
  });

  it("reads as null on an older player's app.js, or anywhere but the first line", () => {
    for (const code of [
      `/*!\n${license}*/\n${IIFE}`,
      IIFE,
      "",
      `${IIFE}/*! Kinetic 1.8.0 */\n`,
      "\n/*! Kinetic 1.8.0 */\n",
      "/* Kinetic 1.8.0 */\n",
      "/*! Kinetic  */\n",
      "/*! Kinetic 1.8.0 */",
    ]) {
      expect(readStamp(code), JSON.stringify(code)).toBeNull();
    }
  });
});

describe("folderKineticVersion", () => {
  it("reads a folder's app.js on disk: stamped, older, or missing", () => {
    const folder = (name, code) => {
      const dir = join(temp, name);
      mkdirSync(dir);
      if (code !== null) writeFileSync(join(dir, "app.js"), code);
      return dir;
    };
    expect(
      folderKineticVersion(
        folder("stamped", `${stampLine("1.8.0-dev")}\n${IIFE}`),
      ),
    ).toBe("1.8.0-dev");
    expect(
      folderKineticVersion(folder("older", `/*!\n${license}*/\n${IIFE}`)),
    ).toBeNull();
    expect(folderKineticVersion(folder("empty", null))).toBeNull();
    expect(folderKineticVersion(join(temp, "no-such-folder"))).toBeNull();
  });
});
