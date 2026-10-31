import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The timeline machine must stay free of DOM and browser-global references so
// it is unit-testable under Node and reusable outside a browser. This guard
// reads the non-test source files in this directory and asserts none of them
// name a browser global. It is the durable form of docs/plan.md Phase 3's
// "machine modules DOM-free" requirement.

const here = dirname(fileURLToPath(import.meta.url));

// Identifiers that only exist in a browser (or that would couple the machine to
// a host). word-bounded so a name like `windowed` does not false-positive.
const BROWSER_GLOBALS = [
  "document",
  "window",
  "navigator",
  "HTMLElement",
  "Element",
  "NodeListOf",
  "localStorage",
  "indexedDB",
  "requestAnimationFrame",
  "fetch",
];

const sourceFiles = readdirSync(here).filter(
  (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
);

describe("machine is DOM-free", () => {
  it("has source files to guard", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  for (const file of sourceFiles) {
    it(`${file} references no browser globals`, () => {
      const src = readFileSync(join(here, file), "utf8");
      for (const global of BROWSER_GLOBALS) {
        const re = new RegExp(`\\b${global}\\b`);
        expect(re.test(src), `${file} must not reference ${global}`).toBe(
          false,
        );
      }
    });
  }
});
