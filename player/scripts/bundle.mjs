// The player bundle is three files: index.html, app.js, and manifest.js.
// Shared by the build and dev scripts so both stage the same bundle, and
// later by packaging (docs/plan.md Phase 12), which copies the bundle into a
// content folder — that folder ships its own manifest.js, so the stub is
// only ever written where no manifest.js exists. app.js and index.html open
// with Kinetic's version (the repo's VERSION, stamped as version.mjs says)
// and its MIT notice, read from the repo's LICENSE, so every folder that
// ships them carries both; the player reads the version as a compile-time
// constant.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import esbuild from "esbuild";
import { KINETIC_VERSION, stampLine, VERSION_DEFINE } from "./version.mjs";

/** Kinetic's license: the repo's LICENSE file, whole. */
export const LICENSE_TEXT = readFileSync(
  new URL("../../LICENSE", import.meta.url),
  "utf8",
);

/**
 * The esbuild options the build and dev scripts share. The player is opened
 * over file://, which blocks ES modules (see docs/stack.md), so the output
 * format is fixed as iife; the version stamp and the notice go on as a
 * banner, which esbuild writes whatever `legalComments` says, the stamp
 * first; `define` gives src/version.ts the version.
 */
export const BUNDLE_OPTIONS = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  define: VERSION_DEFINE,
  banner: { js: `${stampLine(KINETIC_VERSION)}\n/*!\n${LICENSE_TEXT}*/` },
};

/** A real, valid, empty manifest: the player shows its no-content state. */
export const EMPTY_MANIFEST = {
  schemaVersion: 1,
  width: 1,
  height: 1,
  items: [],
};

/**
 * A bare `dist/index.html` opened over `file://` has no content folder to
 * read, so its stub defines the global with a real object. `??` then
 * short-circuits and the app never attempts the fetch that `file://` blocks —
 * no rejected promise, no console error, just the empty-manifest state.
 */
export const MANIFEST_STUB = `window.KINETIC_MANIFEST = ${JSON.stringify(EMPTY_MANIFEST, null, 2)};\n`;

const DOCTYPE = "<!doctype html>\n";

/** Builds app.js (no source map, no other comments) and stages the rest. */
export async function buildBundle(outDir) {
  await esbuild.build({
    ...BUNDLE_OPTIONS,
    legalComments: "none",
    outfile: join(outDir, "app.js"),
  });
  return stageBundleFiles(outDir);
}

/**
 * Writes index.html with the version and the notice as comments after its
 * doctype (which stays first, so no engine reads the page in quirks mode),
 * and supplies a manifest.js if the directory has none.
 */
export function stageBundleFiles(destDir) {
  mkdirSync(destDir, { recursive: true });
  const page = readFileSync("index.html", "utf8");
  if (!page.startsWith(DOCTYPE)) {
    throw new Error(`index.html must start with ${JSON.stringify(DOCTYPE)}`);
  }
  writeFileSync(
    join(destDir, "index.html"),
    `${DOCTYPE}<!-- Kinetic ${KINETIC_VERSION} -->\n<!--\n${LICENSE_TEXT}-->\n${page.slice(DOCTYPE.length)}`,
  );
  return ensureManifestStub(destDir);
}

/** Writes the stub only when absent. Returns "written" or "kept". */
export function ensureManifestStub(destDir) {
  const target = join(destDir, "manifest.js");
  if (existsSync(target)) return "kept";
  writeFileSync(target, MANIFEST_STUB);
  return "written";
}
