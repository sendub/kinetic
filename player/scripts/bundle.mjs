// The player bundle is three files: index.html, app.js, and manifest.js.
// Shared by the build and dev scripts so both stage the same bundle, and
// later by packaging (docs/plan.md Phase 12), which copies the bundle into a
// content folder — that folder ships its own manifest.js, so the stub is
// only ever written where no manifest.js exists.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

/** Copies index.html and supplies a manifest.js if the directory has none. */
export function stageBundleFiles(destDir) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync("index.html", join(destDir, "index.html"));
  return ensureManifestStub(destDir);
}

/** Writes the stub only when absent. Returns "written" or "kept". */
export function ensureManifestStub(destDir) {
  const target = join(destDir, "manifest.js");
  if (existsSync(target)) return "kept";
  writeFileSync(target, MANIFEST_STUB);
  return "written";
}
