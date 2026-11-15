// The built bundle carries Kinetic's MIT notice (the repo's LICENSE) at the
// top of app.js and index.html, so every game folder ships it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBundle } from "./bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const license = readFileSync(resolve(here, "../../LICENSE"), "utf8");
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

describe("the built bundle's license notice", () => {
  it("is the LICENSE file, whole", () => {
    expect(license).toMatch(
      /^MIT License\n\nCopyright \(c\) 2026 Sendu Bala\n/,
    );
    expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it("opens app.js as a comment, ahead of the classic IIFE", () => {
    const code = readFileSync(join(out, "app.js"), "utf8");
    expect(code.startsWith(`/*!\n${license}*/\n`)).toBe(true);
    const body = code.slice(`/*!\n${license}*/\n`.length);
    expect(body).toMatch(/^(?:"use strict";\n)?\(\(\) => \{/);
    expect(body).not.toMatch(/^\s*(?:import|export)\s/m);
    // Still one script a browser runs as is.
    expect(() => new Script(code)).not.toThrow();
  });

  it("follows index.html's doctype as a comment, the page otherwise as written", () => {
    const html = readFileSync(join(out, "index.html"), "utf8");
    const comment = `<!--\n${license}-->\n`;
    const [doctype, ...rest] = source.split("\n");
    expect(doctype).toBe("<!doctype html>");
    expect(html).toBe(`${doctype}\n${comment}${rest.join("\n")}`);
    // Nothing in the notice ends or nests an HTML comment.
    expect(license).not.toMatch(/--|<!|>/);
  });
});
