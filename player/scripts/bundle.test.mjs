// The built bundle carries Kinetic's version (the repo's VERSION) and MIT
// notice (its LICENSE) at the top of app.js and index.html, so every game
// folder ships them, and the player reads the version as a compile-time
// constant (scripts/version.mjs).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext, Script } from "node:vm";
import esbuild from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_OPTIONS, buildBundle } from "./bundle.mjs";
import { readStamp } from "./version.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const license = readFileSync(resolve(here, "../../LICENSE"), "utf8");
const version = readFileSync(resolve(here, "../../VERSION"), "utf8").trim();
const stamp = `/*! Kinetic ${version} */\n`;
const source = readFileSync(resolve(here, "../index.html"), "utf8");
const scratch = resolve(here, "../../.tmp");
let out;

beforeAll(async () => {
  mkdirSync(scratch, { recursive: true });
  out = mkdtempSync(join(scratch, "bundle-test-"));
  await buildBundle(out);
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("the built bundle's version", () => {
  it("is app.js's first line, the stamp a tool reads back", () => {
    const code = readFileSync(join(out, "app.js"), "utf8");
    expect(code.startsWith(stamp)).toBe(true);
    expect(readStamp(code)).toBe(version);
  });

  it("is a constant the player reads, from src/version.ts", async () => {
    const built = await esbuild.build({
      ...BUNDLE_OPTIONS,
      entryPoints: undefined,
      stdin: {
        contents:
          'import { KINETIC_VERSION } from "./src/version.ts"; globalThis.read = KINETIC_VERSION;',
        resolveDir: resolve(here, ".."),
        loader: "ts",
      },
      write: false,
    });
    const sandbox = {};
    runInNewContext(built.outputFiles[0].text, sandbox);
    expect(sandbox.read).toBe(version);
  });
});

describe("the built bundle's license notice", () => {
  it("is the LICENSE file, whole", () => {
    expect(license).toMatch(
      /^MIT License\n\nCopyright \(c\) 2026 Sendu Bala\n/,
    );
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("follows the stamp in app.js as a comment, ahead of the classic IIFE", () => {
    const code = readFileSync(join(out, "app.js"), "utf8");
    const head = `${stamp}/*!\n${license}*/\n`;
    expect(code.startsWith(head)).toBe(true);
    const body = code.slice(head.length);
    expect(body).toMatch(/^(?:"use strict";\n)?\(\(\) => \{/);
    expect(body).not.toMatch(/^\s*(?:import|export)\s/m);
    // Still one script a browser runs as is.
    expect(() => new Script(code)).not.toThrow();
  });

  it("follows index.html's doctype and version as a comment, the page otherwise as written", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const comment = `<!-- Kinetic ${version} -->\n<!--\n${license}-->\n`;
    const [doctype, ...rest] = source.split("\n");
    expect(doctype).toBe("<!doctype html>");
    expect(html).toBe(`${doctype}\n${comment}${rest.join("\n")}`);
    // Nothing in the notice ends or nests an HTML comment.
    expect(license).not.toMatch(/--|<!|>/);
  });
});
